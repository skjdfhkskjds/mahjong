# Testing strategy

Tests are acceptance evidence for the roadmap. Favor behavioral guarantees over a repository-wide coverage number.

## Determinism contract

All pure decisions receive clock values, IDs, and random bytes explicitly. Failures from seeded tests print the seed and a minimal replay transcript. Commands, events, states, profiles, views, and persisted envelopes have round-trip serialization tests.

## Required test families

- Unit and decision-table tests for rules and profile validation.
- Golden positive, near-miss, interaction, supersession, and payment fixtures for scoring.
- Property tests for physical tile conservation, legal hand sizes, replay equivalence, and projection noninterference.
- Exhaustive small-state/model tests and arrival-permutation tests for reaction resolution.
- Deadline tests immediately before, at, and after the due time.
- Idempotency tests for duplicate commands, alarms, reconnects, and recovery.
- Permanent compatibility fixtures for rules versions, encoding versions, and storage schemas.
- Seeded random-legal-game simulation with invariant checks after every event.
- Workers-runtime tests for SQLite transactions, Durable Object eviction, hibernation, alarms, and WebSocket resync.
- Multi-client browser tests for lobby, hidden hands, reconnect, and complete-hand flows.
- Discord-proxied smoke tests on supported client platforms.

Projection tests compare all viewer classes and assert an allowlist of fields. A stronger noninterference test changes an opponent's concealed state and proves that the viewer projection changes only in permitted public counts or facts.

## CI tiers

### Every pull request

- Formatting and lint checks.
- Strict TypeScript typecheck.
- Import-boundary and package-export validation.
- Pure unit, golden, schema, property, and compatibility tests.
- Production build.
- Conventional Commit and pull-request title checks.

### Main branch or merge queue

- Current `@cloudflare/vitest-plugin` Workers-runtime suite.
- SQLite migration and oldest-fixture recovery.
- Alarm at-least-once, eviction, hibernation, and WebSocket resync tests.
- Multi-client Playwright suite in standalone/mock Discord mode.
- Deployment dry run.

### Nightly or release gate

- Long seeded simulations and race/fuzz tests.
- Reconnect-storm and deadline-processing soak tests.
- Real Discord proxy smoke tests using protected credentials.
- Desktop/web/mobile layout and suspension/resume checks.
- Dependency, license, secret, and vulnerability scanning.

Cloudflare's Workers test package was renamed to `@cloudflare/vitest-plugin` in August 2026. Confirm its current API before scaffolding because this integration is actively evolving.

