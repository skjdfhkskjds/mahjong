use std::{
    env,
    path::Path,
    process::{Command, ExitCode},
};

fn cargo(args: &[&str]) -> ExitCode {
    println!("Running cargo {}", args.join(" "));
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    match Command::new(env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .args(args)
        .current_dir(root)
        .status()
    {
        Ok(status) if status.success() => ExitCode::SUCCESS,
        Ok(_) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("Could not run cargo {}: {error}", args.join(" "));
            ExitCode::FAILURE
        }
    }
}

pub(crate) fn format(check: bool) -> ExitCode {
    if check {
        cargo(&["fmt", "--all", "--", "--check"])
    } else {
        cargo(&["fmt", "--all"])
    }
}

pub(crate) fn clippy() -> ExitCode {
    cargo(&[
        "clippy",
        "--workspace",
        "--all-targets",
        "--locked",
        "--",
        "-D",
        "warnings",
    ])
}
