# Contributing

## Workflow

Work in small, reviewable stages. Each implementation stage must end with its exit criteria verified and a commit before the next stage begins. Do not scaffold empty future packages or directories merely to reserve names.

Use Conventional Commits for every commit and Conventional Commit syntax for pull request titles. Examples:

```text
docs: establish implementation roadmap
chore(repo): configure TypeScript workspace
feat(game-core): add physical tile identities
fix(table-room): make command replay idempotent
test(projection): prevent concealed-hand disclosure
```

Breaking changes use `!` and explain the compatibility impact in the body:

```text
feat(protocol)!: version viewer-safe table deltas
```

## Pull requests

Every pull request should state:

- The roadmap milestone and acceptance criterion it advances.
- What was deliberately left out.
- How the change was verified.
- Whether it changes rules semantics, protocol compatibility, persisted state, privacy boundaries, or deployment configuration.
- Which permanent fixture or migration was added for a persistence change.

A rules-semantic change must update the Hong Kong decision register, worked examples, and traceability fixtures. A persisted-format change must retain a fixture from the oldest supported format and prove recovery or migration.

## Engineering constraints

- Application and game code is TypeScript.
- Enable strict TypeScript, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Runtime schemas validate every untrusted HTTP, WebSocket, persisted, and Discord payload.
- Packages never import from applications.
- The client and Worker never import from each other.
- Pure game packages contain no React, Discord, Cloudflare, network, storage, or clock dependencies.
- Persist before broadcasting.
- Never send canonical state or canonical domain events to clients.
- Never add a rule based on an undocumented assumption.
