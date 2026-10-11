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
