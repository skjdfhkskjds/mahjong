use std::{error::Error, io, process::ExitStatus};

#[derive(Debug, thiserror::Error)]
pub(crate) enum TaskError {
    #[error("{0}")]
    Usage(&'static str),
    #[error("Could not run {command}: {source}")]
    Spawn {
        command: String,
        #[source]
        source: io::Error,
    },
    #[error("{command} failed with {status}")]
    Command { command: String, status: ExitStatus },
    #[error(transparent)]
    Sql(#[from] Box<dyn Error>),
}
