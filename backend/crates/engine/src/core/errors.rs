use crate::storage::StoreError;

use rulesets::RulesError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error(transparent)]
    Rules(#[from] RulesError),
    #[error(transparent)]
    Repository(#[from] StoreError),
    #[error("invalid session or coordination record")]
    InvalidRecord,
    #[error("operation is unavailable in this phase")]
    InvalidPhase,
    #[error("seat is unavailable or participant identity is invalid")]
    InvalidParticipant,
    #[error("stale match or response round")]
    Stale,
    #[error("seat already submitted a different response")]
    AlreadyResponded,
    #[error("deadline exceeded")]
    DeadlineExceeded,
    #[error("identifier or timestamp overflow")]
    Overflow,
}
