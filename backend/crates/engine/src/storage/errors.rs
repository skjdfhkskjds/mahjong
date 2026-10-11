use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("concurrent session update")]
    Conflict,
    #[error("invalid stored record")]
    InvalidRecord,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}
