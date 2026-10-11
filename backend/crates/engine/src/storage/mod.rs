mod errors;
pub use errors::StoreError;
pub mod sqlite;

use std::future::Future;

use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct StoredSession {
    pub revision: u64,
    pub payload: Value,
}

/// Compare-and-swap persists the complete private session atomically.
/// `None` creates a new session at revision one. A conflict never overwrites data.
pub trait Store {
    fn load(
        &self,
        session_id: &str,
    ) -> impl Future<Output = Result<Option<StoredSession>, StoreError>> + Send;

    fn save(
        &self,
        session_id: &str,
        expected_revision: Option<u64>,
        payload: &Value,
    ) -> impl Future<Output = Result<u64, StoreError>> + Send;
}
