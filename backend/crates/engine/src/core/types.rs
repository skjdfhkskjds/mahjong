use rulesets::{Checkpoint, HandOutcome, Response, Seat};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Timing {
    pub response_ms: u64,
    pub intermission_ms: u64,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            response_ms: 60_000,
            intermission_ms: 5_000,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MatchStatus {
    Playing,
    Intermission,
    Completed,
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StopVote {
    pub hand_number: u64,
    pub agreed: [bool; 4],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Round<M> {
    pub id: u64,
    pub deadline: u64,
    pub responses: Vec<Response<M>>,
    pub fallback_requested: Vec<Seat>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt<M> {
    pub round_id: u64,
    pub response: Response<M>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchRecord<M> {
    pub id: String,
    pub participants: [String; 4],
    pub status: MatchStatus,
    pub checkpoint: Checkpoint,
    pub round: Option<Round<M>>,
    pub last_round_id: u64,
    pub receipts: Vec<Receipt<M>>,
    pub intermission_deadline: Option<u64>,
    pub stop_vote: Option<StopVote>,
    pub results: Vec<HandOutcome>,
    pub points: [i64; 4],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Session<C, M> {
    pub version: u32,
    pub seats: [Option<String>; 4],
    pub ready: [bool; 4],
    pub config: C,
    pub timing: Timing,
    pub current: Option<MatchRecord<M>>,
    pub history: Vec<MatchRecord<M>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResponseOrigin {
    Participant,
    Fallback,
}

#[derive(Clone, Debug)]
pub struct MoveEnvelope<M> {
    pub match_id: String,
    pub round_id: u64,
    pub response: Response<M>,
    pub origin: ResponseOrigin,
}

/// Seat-specific snapshot. Safe to redeliver after a committed publication fails.
#[derive(Clone, Debug, Serialize)]
pub struct SeatUpdate<V, M> {
    pub revision: u64,
    pub occupants: [Option<String>; 4],
    pub ready: [bool; 4],
    pub seat: Seat,
    pub match_id: Option<String>,
    pub status: Option<MatchStatus>,
    pub view: Option<V>,
    pub moves: Vec<M>,
    pub round_id: Option<u64>,
    pub response_deadline: Option<u64>,
    pub fallback_requested: bool,
    pub response_accepted: bool,
    pub intermission_deadline: Option<u64>,
    pub stop_vote: Option<StopVote>,
    pub results: Vec<HandOutcome>,
    pub points: [i64; 4],
}
