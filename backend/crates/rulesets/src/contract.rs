use std::fmt::Debug;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::RulesError;

/// Stable participant position. A ruleset maps positions to changing hand winds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Seat {
    East,
    South,
    West,
    North,
}

impl Seat {
    pub const ALL: [Self; 4] = [Self::East, Self::South, Self::West, Self::North];

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn next(self) -> Self {
        Self::ALL[(self.index() + 1) % 4]
    }

    pub fn distance_from(self, source: Self) -> usize {
        (self.index() + 4 - source.index()) % 4
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Phase {
    Playing,
    HandComplete,
    MatchComplete,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandOutcome {
    pub hand_number: u64,
    pub winner: Option<Seat>,
    pub points: [i64; 4],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Opportunity<M> {
    pub seat: Seat,
    pub moves: Vec<M>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response<M> {
    pub seat: Seat,
    pub action: M,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inspection<M> {
    pub hand_number: u64,
    pub phase: Phase,
    pub opportunities: Vec<Opportunity<M>>,
    pub outcome: Option<HandOutcome>,
}

#[derive(Clone, Debug)]
pub struct Transition<S, M> {
    pub state: S,
    pub inspection: Inspection<M>,
}

/// Private persistence data, never a participant publication.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub ruleset_id: String,
    pub version: u32,
    pub state: Value,
}

/// Pure domain boundary. Each operation leaves its accepted input untouched.
pub trait Ruleset: Clone {
    type State: Clone;

    type Move: Clone + Debug + PartialEq + Serialize + DeserializeOwned;

    type View: Clone + Debug + Serialize;

    type Config: Clone + Debug + Serialize + DeserializeOwned;

    type Inputs;

    fn initialize(
        &self,
        config: &Self::Config,
        participants: &[String; 4],
        inputs: &Self::Inputs,
    ) -> Result<Transition<Self::State, Self::Move>, RulesError>;

    fn inspect(&self, state: &Self::State) -> Result<Inspection<Self::Move>, RulesError>;

    fn validate_response(
        &self,
        state: &Self::State,
        response: &Response<Self::Move>,
    ) -> Result<(), RulesError>;

    fn resolve(
        &self,
        state: &Self::State,
        responses: &[Response<Self::Move>],
        inputs: &Self::Inputs,
    ) -> Result<Transition<Self::State, Self::Move>, RulesError>;

    fn advance_hand(
        &self,
        state: &Self::State,
        inputs: &Self::Inputs,
    ) -> Result<Transition<Self::State, Self::Move>, RulesError>;

    fn project(&self, state: &Self::State, seat: Seat) -> Result<Self::View, RulesError>;

    fn checkpoint(&self, state: &Self::State) -> Result<Checkpoint, RulesError>;

    /// Verify the coordinator's match metadata against the opaque rules state.
    fn validate_context(
        &self,
        state: &Self::State,
        config: &Self::Config,
        participants: &[String; 4],
        outcomes: &[HandOutcome],
    ) -> Result<(), RulesError>;

    fn restore(&self, checkpoint: &Checkpoint) -> Result<Self::State, RulesError>;
}
