use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SubscribeError {
    #[error("subscriber IDs exhausted")]
    SubscriberIdsExhausted,
}
