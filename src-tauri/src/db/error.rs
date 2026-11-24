use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Database(#[from] sea_orm::DbErr),
    #[error("migration error: {0}")]
    Migration(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("validation error: {0}")]
    Validation(String),
    /// A write that another row's claim on a unique key makes impossible, and
    /// that no retry can resolve — as opposed to the transient contention
    /// `Database` usually carries. Distinct because the caller's correct
    /// response differs: it must ABANDON the operation rather than retry it or
    /// treat it as a benign no-op.
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for DbError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
