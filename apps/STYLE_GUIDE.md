# TypeScript style guide

This guide supplements the TypeScript, ESLint, Prettier, boundary, and export checks. Automation is authoritative for rules it enforces; the remaining rules require review.

## Files and modules

- Use kebab-case filenames, `PascalCase` types/classes, and `camelCase` values/functions. Use `UPPER_SNAKE_CASE` for shared limits and immutable configuration constants, not every module-scoped `const`.
- Use ESM, named exports, `.js` suffixes on relative TypeScript/JavaScript module specifiers, and `type` modifiers for type-only imports/exports. Reserve default exports for framework entry points that require them.
- Import other packages only through declared public exports. Never deep-import package internals, including by relative path; passing boundary checks does not prove every relative import is valid.
- Entrypoints and routers coordinate. Durable Object classes own lifecycle and transaction orchestration; keep wire schemas/parsers, pure projections, and domain transitions in focused modules. Do not add a new responsibility to an oversized coordinator; extract the touched responsibility when reasonably scoped.
- Split modules by responsibility without creating catch-all `common`, `shared`, `utils`, or `helpers` modules.

## Types and control flow

- Prefer `interface` for object contracts and `type` for unions, aliases, and brands. Mark domain, protocol, and configuration data `readonly`.
- Model commands, events, phases, and results as discriminated unions and handle them exhaustively.
- Annotate package public APIs and trust-boundary signatures; infer obvious local and internal exported types.
- Treat external data as `unknown` and validate before use. Avoid `any`, `@ts-ignore`, non-null assertions, and unchecked casts. In tests or platform shims, keep necessary assertions at the mock boundary; in production, isolate and explain an unavoidable chained cast.
- With exact optional types, omit an absent optional property instead of assigning `undefined` unless explicitly allowed.
- Use erasable syntax: no enums, runtime namespaces, or parameter properties.
- Prefer `const`, early returns, and braces for control flow. Comments explain rationale, invariants, security, or compatibility—not syntax.
- Fail early with stable, non-secret errors. Catch only to recover, clean up, or translate an error at a boundary; preserve the cause when useful.

## Architecture and security

- Pure packages contain no React, Discord, Cloudflare, network, storage, ambient time, or ambient randomness. Inject time, IDs, and random bytes.
- Packages never import applications; client and Worker never import each other. Adapters translate platform data; domain code decides, evolves, projects, and checks invariants.
- Reject unknown fields in project-owned wire and persisted formats; validate their exact shape, supported version where versioned, and size bounds. Centralize stable wire types and validators in the protocol package when it has real code.
- For third-party APIs such as Discord, bound response size and validate only fields the application relies on; tolerate compatible additive fields.
- The Worker is authoritative. Persist accepted changes atomically before acknowledging or broadcasting, and send only viewer-safe projections—not canonical state or events.
- When awaiting non-storage work in a Durable Object, assume another event may interleave and recheck state. Keep write-dependent acknowledgements and broadcasts behind successful persistence/output gates.
- Logs are allowlist-based. Never log secrets, tokens, cookies, command bodies, hidden state, gameplay entropy, shuffle seeds, unrevealed fairness inputs, walls, projections, or canonical state.

## Discord Activity code

- This project is an Activity using the Embedded App SDK and Discord REST, not a Gateway bot. Do not add a companion-bot command surface, Gateway intents/process, or bot framework without an explicit architecture decision.
- Treat SDK identity and metadata as untrusted. Verify Activity-instance membership on the backend before granting table authority; knowing a `tableId` is not authorization.
- Keep the OAuth access token used by SDK authentication separate from the application session. Secrets and bot credentials remain Worker-only and out of source, responses, and logs.
- Pin the Discord API version, send an identifying `User-Agent`, URL-encode path values, and reject redirects. Respect rate-limit headers and `Retry-After`; retry only bounded, idempotent work and do not retry permanent authorization/not-found failures.
- If server-handled interactions are introduced, verify signatures against the raw body, meet Discord's acknowledgement deadline, and disable mention parsing by default.

## Tests

- Test behavior and invariants, not implementation details. Every behavior fix gets a focused regression test.
- Cover valid, invalid, and boundary cases as applicable, plus serialization, replay, idempotency, recovery, migration, and hidden-state noninterference.
- Co-locate pure/client `*.test.ts(x)` files; keep Workers-runtime, Durable Object, eviction, and socket tests under `apps/discord-activity/tests`.
- Keep tests deterministic. Pass clock/random inputs explicitly and print reproducible seeds for generated cases.

See [CONTRIBUTING.md](CONTRIBUTING.md), the [technical baseline](docs/architecture/technical-baseline.md), and the [testing strategy](docs/testing-strategy.md) for project-level invariants.
