#!/usr/bin/env bash
set -euo pipefail

MIGRATIONS_PATH="backend/crates/engine/src/storage/sqlite/migrations"

cd "$(dirname "$0")/../.."
task_sqlx_dir=$(mktemp -d)
trap 'rm -rf "$task_sqlx_dir"' EXIT
export DATABASE_URL="sqlite://$task_sqlx_dir/schema.sqlite"
export SQLX_OFFLINE=false
cargo sqlx database create
cargo sqlx migrate run --source "$MIGRATIONS_PATH"
cargo sqlx prepare --workspace "$@" -- --all-targets --locked
