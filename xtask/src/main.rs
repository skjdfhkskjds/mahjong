mod check;
mod precommit;
mod rust;
mod sql;

use std::{env, process::ExitCode};

const USAGE: &str = "Usage: cargo xtask <command>\n\nCommands:\n  precommit   Format SQL and Rust, then run Clippy\n  check       Check SQL and Rust formatting, then run Clippy\n  format-sql  Format SQL files and inline SQLx queries";

fn main() -> ExitCode {
    let args: Vec<_> = env::args().skip(1).collect();
    match args.split_first() {
        Some((command, args)) if command == "precommit" => precommit::execute(args),
        Some((command, args)) if command == "check" => check::execute(args),
        Some((command, args)) if command == "format-sql" => sql::execute(args),
        Some((flag, [])) if flag == "--help" || flag == "-h" => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
