mod format_sql;

use std::{env, process::ExitCode};

fn main() -> ExitCode {
    let args: Vec<_> = env::args().skip(1).collect();
    match args.split_first() {
        Some((command, args)) if command == "format-sql" => format_sql::execute(args),
        Some((flag, [])) if flag == "--help" || flag == "-h" => {
            println!("{}", format_sql::USAGE);
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{}", format_sql::USAGE);
            ExitCode::from(2)
        }
    }
}
