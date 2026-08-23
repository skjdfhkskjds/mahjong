# Repository layout

This is the intended shape, not a command to create empty directories. Add a package or directory only when its milestone gives it code, tests, or an ownership document.

```text
mahjong-bot/
├── apps/
│   └── discord-activity/
│       ├── src/client/       # React, Discord bridge, transport, UI
│       ├── src/worker/       # HTTP, auth, Discord REST, Durable Objects
│       └── tests/            # runtime-boundary and browser tests
├── packages/
│   ├── game-core/            # deliberately small variant-neutral contracts
│   ├── rules-hong-kong/      # hong-kong/v1 profile and pure engine
│   ├── protocol/             # runtime-validated HTTP/WebSocket contracts
│   ├── fairness/             # canonical encoding, shuffle, commitments, audit
│   └── testkit/              # fixtures, builders, replay, simulations
├── docs/
│   ├── architecture/
│   ├── decisions/
│   ├── protocol/
│   └── rules/hong-kong-v1/
├── tooling/                  # boundary and export verification
└── .github/                  # CI, deploy, and review templates
```

Do not add `rules-japanese` until Japanese work begins. Do not create catch-all `common`, `shared`, `utils`, `helpers`, or `misc` modules.

## Application ownership

`src/client` owns browser bootstrap, the real/mock Discord bridge, session/view stores, reconnecting transport, responsive UI, and optional verification. It imports package public entry points and never Worker source.

`src/worker` owns HTTP routing, OAuth and sessions, Discord REST calls, instance binding, table coordination, storage, alarms, sockets, and allowlisted observability. It imports package public entry points and never client source.

The `TableRoom` implementation keeps room lifecycle separate from the rules-owned game aggregate even though both are coordinated in the same Durable Object.

## Package ownership

- `game-core`: only concepts proven common across rulesets; it does not become a union of every possible variant.
- `rules-hong-kong`: commands, domain events, views, legal actions, profile validation, engine, scoring, match progression, and invariants for `hong-kong/v1`.
- `protocol`: wire envelopes and runtime schemas; it exposes viewer-safe messages, never canonical domain events.
- `fairness`: deterministic byte encoding and randomness primitives shared by browser and Worker.
- `testkit`: fixture DSL, builders, scripted/replayed games, and seeded simulations. Production packages never depend on it.

Each package exposes deliberate root or documented subpath exports. Deep internal imports are rejected mechanically.

