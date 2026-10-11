mod check;

mod errors;

mod precommit;

mod rust;

mod sql;

use std::{env, process::ExitCode};

use errors::TaskError;

const USAGE: &str = "Usage: cargo xtask <command>\n\nCommands:\n  precommit     Format SQL and Rust, prepare SQLx metadata, then run Clippy\n  check         Check formatting and SQLx metadata, then run Clippy\n  format-sql    Format SQL files and inline SQLx queries\n  sqlx-prepare  Prepare SQLx offline metadata (--check to verify)";

fn main() -> ExitCode {
    let args: Vec<_> = env::args().skip(1).collect();

    let result = match args.split_first() {
        Some((command, args)) if command == "precommit" => precommit::execute(args),
        Some((command, args)) if command == "check" => check::execute(args),
        Some((command, args)) if command == "format-sql" => sql::execute(args),
        Some((command, args)) if command == "sqlx-prepare" => sql::execute_prepare(args),
        Some((flag, [])) if flag == "--help" || flag == "-h" => {
            println!("{USAGE}");
            Ok(())
        }

        _ => Err(TaskError::Usage(USAGE)),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,

        Err(error) => {
            eprintln!("{error}");

            match error {
                TaskError::Usage(_) => ExitCode::from(2),
                _ => ExitCode::FAILURE,
            }
        }
    }
}
