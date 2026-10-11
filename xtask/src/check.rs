use crate::{errors::TaskError, rust, sql};

const USAGE: &str = "Usage: cargo xtask check";

pub(crate) fn execute(args: &[String]) -> Result<(), TaskError> {
    if args == ["--help"] || args == ["-h"] {
        println!("{USAGE}");
        return Ok(());
    }

    if !args.is_empty() {
        return Err(TaskError::Usage(USAGE));
    }

    sql::format(true)?;
    sql::prepare(true)?;
    rust::format(true)?;
    rust::clippy()?;

    Ok(())
}
