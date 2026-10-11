use std::{str::FromStr, time::Duration};

use serde_json::Value;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};

use super::{Store, StoreError, StoredSession};

/// SQLite persistence adapter. Every application query is compile-time checked.
#[derive(Clone)]
pub struct SqliteDb {
    pool: SqlitePool,
}

impl SqliteDb {
    pub async fn connect(url: &str) -> Result<Self, StoreError> {
        let options = SqliteConnectOptions::from_str(url)
            .map_err(|_| StoreError::InvalidRecord)?
            .create_if_missing(true)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;

        sqlx::migrate!("./src/storage/sqlite/migrations")
            .run(&pool)
            .await
            .map_err(sqlx::Error::from)?;

        Ok(Self { pool })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    /// Authoritative history for server-side inspection, never a client projection.
    pub async fn load_revision(
        &self,
        session_id: &str,
        revision: u64,
    ) -> Result<Option<StoredSession>, StoreError> {
        let revision = i64::try_from(revision).map_err(|_| StoreError::InvalidRecord)?;
        let row = sqlx::query!(
            "SELECT revision, payload FROM session_revisions WHERE session_id = ? AND revision = ?",
            session_id,
            revision
        )
        .fetch_optional(&self.pool)
        .await?;

        row.map(|row| {
            Ok(StoredSession {
                revision: u64::try_from(row.revision).map_err(|_| StoreError::InvalidRecord)?,
                payload: serde_json::from_str(&row.payload)
                    .map_err(|_| StoreError::InvalidRecord)?,
            })
        })
        .transpose()
    }
}

impl Store for SqliteDb {
    async fn load(&self, session_id: &str) -> Result<Option<StoredSession>, StoreError> {
        let row = sqlx::query!(
            "SELECT revision, payload FROM sessions WHERE session_id = ?",
            session_id
        )
        .fetch_optional(&self.pool)
        .await?;

        row.map(|row| {
            Ok(StoredSession {
                revision: u64::try_from(row.revision).map_err(|_| StoreError::InvalidRecord)?,
                payload: serde_json::from_str(&row.payload)
                    .map_err(|_| StoreError::InvalidRecord)?,
            })
        })
        .transpose()
    }

    async fn save(
        &self,
        session_id: &str,
        expected_revision: Option<u64>,
        payload: &Value,
    ) -> Result<u64, StoreError> {
        if session_id.trim().is_empty() {
            return Err(StoreError::InvalidRecord);
        }

        let revision = expected_revision
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(StoreError::InvalidRecord)?;

        let next_revision = i64::try_from(revision).map_err(|_| StoreError::InvalidRecord)?;
        let encoded = serde_json::to_string(payload).map_err(|_| StoreError::InvalidRecord)?;

        let mut transaction = self.pool.begin().await?;
        let changed = if let Some(expected) = expected_revision {
            let expected = i64::try_from(expected).map_err(|_| StoreError::InvalidRecord)?;
            sqlx::query!("UPDATE sessions SET revision = ?, payload = ? WHERE session_id = ? AND revision = ?", next_revision, encoded, session_id, expected)
                .execute(&mut *transaction).await?.rows_affected()
        } else {
            sqlx::query!("INSERT INTO sessions (session_id, revision, payload) VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING", session_id, next_revision, encoded)
                .execute(&mut *transaction).await?.rows_affected()
        };
        if changed != 1 {
            transaction.rollback().await?;
            return Err(StoreError::Conflict);
        }

        sqlx::query!(
            "INSERT INTO session_revisions (session_id, revision, payload) VALUES (?, ?, ?)",
            session_id,
            next_revision,
            encoded
        )
        .execute(&mut *transaction)
        .await?;

        transaction.commit().await?;
        Ok(revision)
    }
}
