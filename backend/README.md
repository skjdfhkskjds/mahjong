# Rust backend

`mahjong` is the initial binary crate for the replacement backend in the
root Cargo workspace. Its entry point currently exits without starting a
service. It has no dependencies or game behavior.

`backend/crates/` also contains the `engine`, `mailbox`, `rulesets`, and `tasks`
library crates and the `server` binary crate. Their entry points are initialized
but do not yet implement the backend components or start a service.

The [backend redesign](../docs/architecture/backend-redesign/README.md) owns
the component responsibilities and lifecycle decisions. Runtime, transport,
storage, and compatibility choices remain to be implemented as those interfaces
are settled.

## Development

Install Rust through [rustup](https://rustup.rs/). The root `rust-toolchain.toml`
pins Rust 1.97.1 and includes rustfmt and Clippy. Cargo uses that toolchain when
run from this repository.

Run from the repository root:

```sh
cargo run --package mahjong --locked
cargo build --workspace --locked
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

The workspace shares package metadata and lints. Add new crates only when they
have an implementation responsibility, list them explicitly in the root
`Cargo.toml`, and inherit the workspace metadata and lints. Keep `Cargo.lock`
under version control; generated `target/` artifacts are ignored.
