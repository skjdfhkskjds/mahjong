use std::process::ExitCode;

use crate::{rust, sql};

const USAGE: &str = "Usage: cargo xtask precommit";

pub(crate) fn execute(args: &[String]) -> ExitCode {
    if args == ["--help"] || args == ["-h"] {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if !args.is_empty() {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    }
    let status = sql::format(false);
    if status != ExitCode::SUCCESS {
        return status;
    }
    let status = rust::format(false);
    if status != ExitCode::SUCCESS {
        return status;
    }
    rust::clippy()
}
