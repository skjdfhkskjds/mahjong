use thiserror::Error;

#[derive(Debug, Error)]
pub enum RulesError {
    #[error("invalid rules configuration: {0}")]
    InvalidConfiguration(String),
    #[error("invalid explicit input: {0}")]
    InvalidInput(String),
    #[error("invalid response: {0}")]
    InvalidResponse(String),
    #[error("invalid checkpoint: {0}")]
    InvalidCheckpoint(String),
    #[error("unsupported checkpoint identity or version")]
    UnsupportedCheckpoint,
    #[error("operation is unavailable in this phase")]
    InvalidPhase,
}
