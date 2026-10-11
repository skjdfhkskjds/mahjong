use crate::{errors::TaskError, rust, sql};

const USAGE: &str = "Usage: cargo xtask precommit";

pub(crate) fn execute(args: &[String]) -> Result<(), TaskError> {
    if args == ["--help"] || args == ["-h"] {
        println!("{USAGE}");
        return Ok(());
    }

    if !args.is_empty() {
        return Err(TaskError::Usage(USAGE));
    }

    sql::format(false)?;
    rust::format(false)?;
    sql::prepare(false)?;
    rust::clippy()?;

    Ok(())
}
