use std::{env, path::Path, process::Command};

use crate::errors::TaskError;

fn cargo(args: &[&str]) -> Result<(), TaskError> {
    println!("Running cargo {}", args.join(" "));

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");

    let command = format!("cargo {}", args.join(" "));
    let status = Command::new(env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .args(args)
        .current_dir(root)
        .status()
        .map_err(|source| TaskError::Spawn {
            command: command.clone(),
            source,
        })?;

    if !status.success() {
        return Err(TaskError::Command { command, status });
    }

    Ok(())
}

pub(crate) fn format(check: bool) -> Result<(), TaskError> {
    if check {
        cargo(&["fmt", "--all", "--", "--check"])
    } else {
        cargo(&["fmt", "--all"])
    }
}

pub(crate) fn clippy() -> Result<(), TaskError> {
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
