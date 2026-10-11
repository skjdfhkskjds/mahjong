use rulesets::{Inspection, Phase, Ruleset, Seat, Transition};

use crate::storage::Store;

use super::{
    EngineError, MatchRecord, MatchStatus, MoveEnvelope, Receipt, ResponseOrigin, Round,
    SeatUpdate, StopVote, Timing, types::Session,
};

fn next(value: u64) -> Result<u64, EngineError> {
    value.checked_add(1).ok_or(EngineError::Overflow)
}

fn deadline(now: u64, duration: u64) -> Result<u64, EngineError> {
    now.checked_add(duration).ok_or(EngineError::Overflow)
}

fn active<M>(record: &MatchRecord<M>) -> bool {
    matches!(
        record.status,
        MatchStatus::Playing | MatchStatus::Intermission
    )
}

/// One serialized session coordinator. Callers authenticate seat identities before use.
/// Methods return only after durable acceptance; `updates` is the publication boundary.
pub struct Engine<R: Ruleset, P: Store> {
    session_id: String,
    revision: u64,
    rules: R,
    repository: P,
    session: Session<R::Config, R::Move>,
    state: Option<R::State>,
}

impl<R: Ruleset, P: Store> Engine<R, P> {
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub async fn create(
        session_id: String,
        config: R::Config,
        timing: Timing,
        rules: R,
        repository: P,
    ) -> Result<Self, EngineError> {
        if session_id.trim().is_empty() || timing.response_ms == 0 {
            return Err(EngineError::InvalidRecord);
        }

        let session = Session {
            version: 1,
            seats: [None, None, None, None],
            ready: [false; 4],
            config,
            timing,
            current: None,
            history: Vec::new(),
        };

        let payload = serde_json::to_value(&session).map_err(|_| EngineError::InvalidRecord)?;
        let revision = repository.save(&session_id, None, &payload).await?;

        Ok(Self {
            session_id,
            revision,
            rules,
            repository,
            session,
            state: None,
        })
    }

    fn validate_record(
        rules: &R,
        record: &MatchRecord<R::Move>,
        state: &R::State,
    ) -> Result<(), EngineError> {
        for (index, id) in record.participants.iter().enumerate() {
            if id.trim().is_empty() || record.participants[..index].contains(id) {
                return Err(EngineError::InvalidRecord);
            }
        }

        let inspection = rules.inspect(state)?;
        let mut points = [0_i64; 4];
        for (index, result) in record.results.iter().enumerate() {
            if result.hand_number != index as u64 + 1
                || result.points.iter().map(|n| i128::from(*n)).sum::<i128>() != 0
            {
                return Err(EngineError::InvalidRecord);
            }

            for seat in Seat::ALL {
                points[seat.index()] = points[seat.index()]
                    .checked_add(result.points[seat.index()])
                    .ok_or(EngineError::Overflow)?;
            }
        }
        if points != record.points {
            return Err(EngineError::InvalidRecord);
        }

        for (index, receipt) in record.receipts.iter().enumerate() {
            if receipt.round_id == 0
                || receipt.round_id > record.last_round_id
                || record.receipts[..index].iter().any(|r| {
                    r.round_id == receipt.round_id && r.response.seat == receipt.response.seat
                })
            {
                return Err(EngineError::InvalidRecord);
            }
        }

        let completed = inspection.phase != Phase::Playing;
        if completed && inspection.outcome.as_ref() != record.results.last() {
            return Err(EngineError::InvalidRecord);
        }

        if !completed && inspection.hand_number != record.results.len() as u64 + 1 {
            return Err(EngineError::InvalidRecord);
        }

        match record.status {
            MatchStatus::Playing => {
                if completed || record.intermission_deadline.is_some() {
                    return Err(EngineError::InvalidRecord);
                }

                let round = record.round.as_ref().ok_or(EngineError::InvalidRecord)?;
                if round.id == 0 || round.id != record.last_round_id {
                    return Err(EngineError::InvalidRecord);
                }

                let mut seen = Vec::new();
                for response in &round.responses {
                    if seen.contains(&response.seat)
                        || !inspection
                            .opportunities
                            .iter()
                            .any(|op| op.seat == response.seat)
                    {
                        return Err(EngineError::InvalidRecord);
                    }

                    rules.validate_response(state, response)?;

                    if !record
                        .receipts
                        .iter()
                        .any(|r| r.round_id == round.id && r.response == *response)
                    {
                        return Err(EngineError::InvalidRecord);
                    }

                    seen.push(response.seat);
                }
                if seen.len() >= inspection.opportunities.len() {
                    return Err(EngineError::InvalidRecord);
                }

                if record.receipts.iter().any(|receipt| {
                    receipt.round_id == round.id && !round.responses.contains(&receipt.response)
                }) {
                    return Err(EngineError::InvalidRecord);
                }

                let mut fallbacks = Vec::new();
                for seat in &round.fallback_requested {
                    if seen.contains(seat)
                        || fallbacks.contains(seat)
                        || !inspection.opportunities.iter().any(|op| op.seat == *seat)
                    {
                        return Err(EngineError::InvalidRecord);
                    }

                    fallbacks.push(*seat);
                }

                if let Some(vote) = &record.stop_vote
                    && (vote.hand_number != inspection.hand_number
                        || !vote.agreed.iter().any(|v| *v))
                {
                    return Err(EngineError::InvalidRecord);
                }
            }
            MatchStatus::Intermission => {
                if inspection.phase != Phase::HandComplete
                    || record.intermission_deadline.is_none()
                    || record.round.is_some()
                    || record.stop_vote.is_some()
                {
                    return Err(EngineError::InvalidRecord);
                }
            }
            MatchStatus::Completed | MatchStatus::Stopped => {
                if !completed
                    || record.round.is_some()
                    || record.stop_vote.is_some()
                    || record.intermission_deadline.is_some()
                    || (record.status == MatchStatus::Completed
                        && inspection.phase != Phase::MatchComplete)
                {
                    return Err(EngineError::InvalidRecord);
                }
            }
        }

        Ok(())
    }

    pub async fn restore(
        session_id: String,
        rules: R,
        repository: P,
    ) -> Result<Option<Self>, EngineError> {
        let Some(saved) = repository.load(&session_id).await? else {
            return Ok(None);
        };

        let session: Session<R::Config, R::Move> =
            serde_json::from_value(saved.payload).map_err(|_| EngineError::InvalidRecord)?;
        if session.version != 1 || saved.revision == 0 || session.timing.response_ms == 0 {
            return Err(EngineError::InvalidRecord);
        }

        for (index, participant) in session.seats.iter().enumerate() {
            if session.ready[index] && participant.is_none() {
                return Err(EngineError::InvalidRecord);
            }
            if let Some(id) = participant
                && (id.trim().is_empty()
                    || session.seats[..index]
                        .iter()
                        .any(|other| other.as_ref() == Some(id)))
            {
                return Err(EngineError::InvalidRecord);
            }
        }

        let mut state = None;
        let mut match_ids = Vec::new();
        for record in session.history.iter().chain(session.current.iter()) {
            if record.id.is_empty() || match_ids.contains(&record.id) {
                return Err(EngineError::InvalidRecord);
            }

            match_ids.push(record.id.clone());

            let restored = rules.restore(&record.checkpoint)?;

            Self::validate_record(&rules, record, &restored)?;
            rules.validate_context(
                &restored,
                &session.config,
                &record.participants,
                &record.results,
            )?;

            if session.history.iter().any(|old| old.id == record.id) && active(record) {
                return Err(EngineError::InvalidRecord);
            }
        }

        if let Some(record) = &session.current {
            if active(record) && session.ready.iter().any(|ready| *ready) {
                return Err(EngineError::InvalidRecord);
            }

            if active(record)
                && Seat::ALL.iter().any(|seat| {
                    session.seats[seat.index()].as_ref() != Some(&record.participants[seat.index()])
                })
            {
                return Err(EngineError::InvalidRecord);
            }

            state = Some(rules.restore(&record.checkpoint)?);
        }

        Ok(Some(Self {
            session_id,
            revision: saved.revision,
            rules,
            repository,
            session,
            state,
        }))
    }

    async fn commit(
        &mut self,
        candidate: Session<R::Config, R::Move>,
        state: Option<R::State>,
    ) -> Result<(), EngineError> {
        if let (Some(record), Some(state)) = (&candidate.current, &state) {
            self.rules.validate_context(
                state,
                &candidate.config,
                &record.participants,
                &record.results,
            )?;
        }

        let payload = serde_json::to_value(&candidate).map_err(|_| EngineError::InvalidRecord)?;

        let revision = self
            .repository
            .save(&self.session_id, Some(self.revision), &payload)
            .await?;

        self.session = candidate;
        self.state = state;
        self.revision = revision;

        Ok(())
    }

    pub async fn occupy(
        &mut self,
        seat: Seat,
        participant: Option<String>,
    ) -> Result<(), EngineError> {
        if self.session.current.as_ref().is_some_and(active) {
            return Err(EngineError::InvalidPhase);
        }

        if let Some(id) = &participant
            && (id.trim().is_empty()
                || Seat::ALL
                    .iter()
                    .any(|s| *s != seat && self.session.seats[s.index()].as_ref() == Some(id)))
        {
            return Err(EngineError::InvalidParticipant);
        }

        let mut candidate = self.session.clone();
        candidate.seats[seat.index()] = participant;
        candidate.ready[seat.index()] = false;
        self.commit(candidate, self.state.clone()).await
    }

    pub async fn ready(&mut self, seat: Seat) -> Result<(), EngineError> {
        if self.session.current.as_ref().is_some_and(active) {
            return Err(EngineError::InvalidPhase);
        }

        if self.session.seats[seat.index()].is_none() {
            return Err(EngineError::InvalidParticipant);
        }

        if self.session.ready[seat.index()] {
            return Ok(());
        }

        let mut candidate = self.session.clone();
        candidate.ready[seat.index()] = true;
        self.commit(candidate, self.state.clone()).await
    }

    fn accept_transition(
        &self,
        record: &mut MatchRecord<R::Move>,
        transition: &Transition<R::State, R::Move>,
        now: u64,
    ) -> Result<(), EngineError> {
        record.checkpoint = self.rules.checkpoint(&transition.state)?;

        let Inspection {
            hand_number,
            phase,
            opportunities,
            outcome,
        } = &transition.inspection;

        if *phase == Phase::Playing {
            if opportunities.is_empty() || outcome.is_some() {
                return Err(EngineError::InvalidRecord);
            }

            record.last_round_id = next(record.last_round_id)?;
            record.round = Some(Round {
                id: record.last_round_id,
                deadline: deadline(now, self.session.timing.response_ms)?,
                responses: Vec::new(),
                fallback_requested: Vec::new(),
            });
            record.status = MatchStatus::Playing;
            record.intermission_deadline = None;
        } else {
            let result = outcome.as_ref().ok_or(EngineError::InvalidRecord)?;
            if result.hand_number != *hand_number
                || *hand_number != record.results.len() as u64 + 1
                || !opportunities.is_empty()
            {
                return Err(EngineError::InvalidRecord);
            }

            for seat in Seat::ALL {
                record.points[seat.index()] = record.points[seat.index()]
                    .checked_add(result.points[seat.index()])
                    .ok_or(EngineError::Overflow)?;
            }
            record.results.push(result.clone());

            let stop = record.stop_vote.as_ref().is_some_and(|vote| {
                vote.hand_number == *hand_number && vote.agreed.iter().all(|v| *v)
            });

            record.stop_vote = None;
            record.round = None;
            record.status = if stop {
                MatchStatus::Stopped
            } else if *phase == Phase::MatchComplete {
                MatchStatus::Completed
            } else {
                MatchStatus::Intermission
            };

            record.intermission_deadline = if record.status == MatchStatus::Intermission {
                Some(deadline(now, self.session.timing.intermission_ms)?)
            } else {
                None
            };
        }

        Ok(())
    }

    pub async fn start_match(
        &mut self,
        match_id: String,
        now: u64,
        inputs: &R::Inputs,
    ) -> Result<(), EngineError> {
        if self.session.current.as_ref().is_some_and(active)
            || !self.session.ready.iter().all(|r| *r)
        {
            return Err(EngineError::InvalidPhase);
        }

        if match_id.trim().is_empty()
            || self
                .session
                .history
                .iter()
                .chain(self.session.current.iter())
                .any(|m| m.id == match_id)
        {
            return Err(EngineError::Stale);
        }

        let participants = self
            .session
            .seats
            .clone()
            .map(|p| p.ok_or(EngineError::InvalidParticipant));
        let [a, b, c, d] = participants;
        let participants = [a?, b?, c?, d?];
        let transition = self
            .rules
            .initialize(&self.session.config, &participants, inputs)?;
        let mut candidate = self.session.clone();
        if let Some(old) = candidate.current.take() {
            candidate.history.push(old);
        }

        let mut record = MatchRecord {
            id: match_id,
            participants,
            status: MatchStatus::Playing,
            checkpoint: self.rules.checkpoint(&transition.state)?,
            round: None,
            last_round_id: 0,
            receipts: Vec::new(),
            intermission_deadline: None,
            stop_vote: None,
            results: Vec::new(),
            points: [0; 4],
        };

        self.accept_transition(&mut record, &transition, now)?;
        candidate.current = Some(record);
        candidate.ready = [false; 4];
        self.commit(candidate, Some(transition.state)).await
    }

    pub async fn respond(
        &mut self,
        envelope: MoveEnvelope<R::Move>,
        now: u64,
        inputs: &R::Inputs,
    ) -> Result<(), EngineError> {
        let record = self
            .session
            .current
            .as_ref()
            .ok_or(EngineError::InvalidPhase)?;
        if record.id != envelope.match_id {
            return Err(EngineError::Stale);
        }

        if let Some(receipt) = record
            .receipts
            .iter()
            .find(|r| r.round_id == envelope.round_id && r.response.seat == envelope.response.seat)
        {
            return if receipt.response.action == envelope.response.action {
                Ok(())
            } else {
                Err(EngineError::AlreadyResponded)
            };
        }

        let round = record.round.as_ref().ok_or(EngineError::Stale)?;
        if round.id != envelope.round_id {
            return Err(EngineError::Stale);
        }

        if let Some(previous) = round
            .responses
            .iter()
            .find(|r| r.seat == envelope.response.seat)
        {
            return if previous.action == envelope.response.action {
                Ok(())
            } else {
                Err(EngineError::AlreadyResponded)
            };
        }

        match envelope.origin {
            ResponseOrigin::Participant if now >= round.deadline => {
                return Err(EngineError::DeadlineExceeded);
            }
            ResponseOrigin::Fallback
                if !round.fallback_requested.contains(&envelope.response.seat) =>
            {
                return Err(EngineError::InvalidPhase);
            }
            _ => {}
        }

        let state = self.state.as_ref().ok_or(EngineError::InvalidRecord)?;
        self.rules.validate_response(state, &envelope.response)?;
        let inspection = self.rules.inspect(state)?;
        if !inspection
            .opportunities
            .iter()
            .any(|o| o.seat == envelope.response.seat)
        {
            return Err(EngineError::InvalidParticipant);
        }

        let mut candidate = self.session.clone();
        let candidate_record = candidate
            .current
            .as_mut()
            .ok_or(EngineError::InvalidRecord)?;
        let candidate_round = candidate_record
            .round
            .as_mut()
            .ok_or(EngineError::InvalidRecord)?;
        candidate_round
            .fallback_requested
            .retain(|s| *s != envelope.response.seat);
        candidate_round.responses.push(envelope.response.clone());
        candidate_record.receipts.push(Receipt {
            round_id: envelope.round_id,
            response: envelope.response,
        });
        let next_state = if candidate_round.responses.len() == inspection.opportunities.len() {
            let transition = self
                .rules
                .resolve(state, &candidate_round.responses, inputs)?;
            self.accept_transition(candidate_record, &transition, now)?;
            Some(transition.state)
        } else {
            self.state.clone()
        };

        self.commit(candidate, next_state).await
    }

    /// Persist missing-seat fallback requests. A mailbox chooses each actual move.
    pub async fn expire_deadlines(&mut self, now: u64) -> Result<(), EngineError> {
        let record = self
            .session
            .current
            .as_ref()
            .ok_or(EngineError::InvalidPhase)?;
        let round = record.round.as_ref().ok_or(EngineError::InvalidPhase)?;
        if now < round.deadline {
            return Ok(());
        }

        let inspection = self
            .rules
            .inspect(self.state.as_ref().ok_or(EngineError::InvalidRecord)?)?;
        let missing: Vec<_> = inspection
            .opportunities
            .iter()
            .filter(|o| !round.responses.iter().any(|r| r.seat == o.seat))
            .map(|o| o.seat)
            .collect();
        if round.fallback_requested == missing {
            return Ok(());
        }

        let mut candidate = self.session.clone();
        candidate
            .current
            .as_mut()
            .and_then(|r| r.round.as_mut())
            .ok_or(EngineError::InvalidRecord)?
            .fallback_requested = missing;
        self.commit(candidate, self.state.clone()).await
    }

    pub async fn agree_stop(
        &mut self,
        match_id: &str,
        seat: Seat,
        hand_number: u64,
    ) -> Result<(), EngineError> {
        let record = self
            .session
            .current
            .as_ref()
            .ok_or(EngineError::InvalidPhase)?;
        if record.id != match_id {
            return Err(EngineError::Stale);
        }

        if record.status != MatchStatus::Playing {
            return Err(EngineError::InvalidPhase);
        }

        let inspection = self
            .rules
            .inspect(self.state.as_ref().ok_or(EngineError::InvalidRecord)?)?;
        if inspection.hand_number != hand_number {
            return Err(EngineError::Stale);
        }

        let mut candidate = self.session.clone();
        let vote = candidate
            .current
            .as_mut()
            .ok_or(EngineError::InvalidRecord)?
            .stop_vote
            .get_or_insert(StopVote {
                hand_number,
                agreed: [false; 4],
            });
        if vote.agreed[seat.index()] {
            return Ok(());
        }

        vote.agreed[seat.index()] = true;
        self.commit(candidate, self.state.clone()).await
    }

    pub async fn advance_hand(&mut self, now: u64, inputs: &R::Inputs) -> Result<(), EngineError> {
        let record = self
            .session
            .current
            .as_ref()
            .ok_or(EngineError::InvalidPhase)?;
        if record.status != MatchStatus::Intermission
            || now
                < record
                    .intermission_deadline
                    .ok_or(EngineError::InvalidRecord)?
        {
            return Err(EngineError::InvalidPhase);
        }

        let transition = self.rules.advance_hand(
            self.state.as_ref().ok_or(EngineError::InvalidRecord)?,
            inputs,
        )?;
        let mut candidate = self.session.clone();
        self.accept_transition(
            candidate
                .current
                .as_mut()
                .ok_or(EngineError::InvalidRecord)?,
            &transition,
            now,
        )?;
        self.commit(candidate, Some(transition.state)).await
    }

    pub fn update(&self, seat: Seat) -> Result<SeatUpdate<R::View, R::Move>, EngineError> {
        let record = self.session.current.as_ref();
        let round = record.and_then(|r| r.round.as_ref());
        let accepted =
            round.is_some_and(|r| r.responses.iter().any(|response| response.seat == seat));
        let participant_matches = record.is_some_and(|r| {
            self.session.seats[seat.index()].as_ref() == Some(&r.participants[seat.index()])
        });
        let view = if participant_matches {
            self.state
                .as_ref()
                .map(|state| self.rules.project(state, seat))
                .transpose()?
        } else {
            None
        };

        let moves = if record.is_some_and(|r| r.status == MatchStatus::Playing) && !accepted {
            self.state
                .as_ref()
                .map(|state| self.rules.inspect(state))
                .transpose()?
                .and_then(|i| i.opportunities.into_iter().find(|o| o.seat == seat))
                .map(|o| o.moves)
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        Ok(SeatUpdate {
            revision: self.revision,
            occupants: self.session.seats.clone(),
            ready: self.session.ready,
            seat,
            match_id: record.map(|r| r.id.clone()),
            status: record.map(|r| r.status),
            view,
            moves,
            round_id: round.map(|r| r.id),
            response_deadline: round.map(|r| r.deadline),
            fallback_requested: round.is_some_and(|r| r.fallback_requested.contains(&seat)),
            response_accepted: accepted,
            intermission_deadline: record.and_then(|r| r.intermission_deadline),
            stop_vote: record.and_then(|r| r.stop_vote.clone()),
            results: record.map(|r| r.results.clone()).unwrap_or_default(),
            points: record.map(|r| r.points).unwrap_or([0; 4]),
        })
    }
}
