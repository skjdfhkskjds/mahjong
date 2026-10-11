# Rust backend

`mahjong` is the initial binary crate for the replacement backend in the
root Cargo workspace. Its entry point currently exits without starting a
service. It has no dependencies or game behavior.

`backend/crates/engine` implements durable session coordination and a SQLx SQLite
repository. `backend/crates/rulesets` defines the variant-neutral domain contract. The `server` entry point remains unwired.

The [implementation contract](docs/architecture/implementation.md) specifies the
API, persistence, recovery, and offline SQLx workflow. Component
responsibilities remain in the [backend design](docs/architecture/README.md).

Follow the [backend style guide](STYLE_GUIDE.md) for Rust code in this directory.

## Development

Install Rust through [rustup](https://rustup.rs/). The root `rust-toolchain.toml`
pins Rust 1.97.1 and includes rustfmt and Clippy. Cargo uses that toolchain when
run from this repository.

Run from the repository root:

```sh
cargo xtask precommit
cargo xtask check
cargo xtask format-sql
cargo xtask format-sql --check
cargo xtask sqlx-prepare
cargo xtask sqlx-prepare --check
cargo run --package mahjong --locked
cargo build --workspace --locked
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

`cargo xtask precommit` formats SQL, runs `cargo fmt --all`, regenerates SQLx
offline metadata, then runs
`cargo clippy --workspace --all-targets --locked -- -D warnings`.
`cargo xtask check` verifies SQL formatting, SQLx metadata, and Rust formatting,
then runs the same Clippy command. It uses SQL `--check`, SQLx `prepare --check`,
and `cargo fmt --all -- --check`, without editing source or committed `.sqlx` files.
Clippy reports warnings as errors in both commands. Each command stops at the
first failure. Enable the checked-in pre-commit hook once per clone:

```sh
git config --local core.hooksPath .githooks
```

The hook runs `cargo xtask precommit`. If backend/tooling or `.sqlx` changes
remain unstaged afterward, it stops the commit. Review and stage the changes,
then retry. This includes existing unstaged backend/tooling edits; the hook does
not stage files automatically.

SQLx preparation runs before Clippy so newly formatted queries can compile offline.

SQL formatting uses the pinned `sql-formatter` CLI through `npx` and requires
Node.js and npm (the first run downloads the formatter). The xtask formats `.sql`
files and literal queries in SQLx `query!`, `query_as!`, and `query_scalar!`
macros, including their unchecked variants, under `backend/crates`. It uses the
SQLite dialect and configuration in `.sql-formatter.json`. Qualified `sqlx::`
macros and bare macro names are recognized; runtime query functions, aliased
macro names, and queries inside other macros are outside this command's scope.
Concatenated or computed query expressions in recognized macros fail explicitly.

`cargo xtask format-sql` (or `--write`) updates files. `--check` leaves files
unchanged and exits nonzero if formatting is needed or a formatter fails.
The Rust CI job runs `cargo xtask check` after installing Rust, Node.js/npm,
and `sqlx-cli`. This checks formatting, SQLx metadata, and Clippy; it does not
execute the test suite. Run `cargo test --workspace --locked` to execute tests.

After formatting inline queries, run `cargo fmt --all` and
`cargo xtask sqlx-prepare` to regenerate the offline `.sqlx` metadata,
then commit those changes together (or run `cargo xtask precommit` for all steps).
`cargo xtask sqlx-prepare --check` verifies the committed metadata. Both modes
create and migrate a temporary SQLite database directly from Rust and clean it
up afterward, including when a command fails. Metadata generation and verification
require `sqlx-cli` 0.9.0 with SQLite support:

```sh
cargo install sqlx-cli --version 0.9.0 --no-default-features --features sqlite --locked
```

Formatting alone does not require a database or the SQLx CLI.
Format migrations before applying them: SQLx checksums migration files,
so reformatting an already-applied migration causes a checksum mismatch.

The workspace shares package metadata and lints. Add new crates only when they
have an implementation responsibility, list them explicitly in the root
`Cargo.toml`, and inherit the workspace metadata and lints. Keep `Cargo.lock`
under version control; generated `target/` artifacts are ignored.
