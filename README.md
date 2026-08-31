# Mahjong Activity

A four-player Hong Kong Mahjong Discord Activity, built as a TypeScript monorepo and deployed as a React client plus Cloudflare Worker and Durable Objects.

## Status

Milestone 4 is complete locally. Four authenticated table members can occupy persistent seats, ready up, receive distinct private hands, and play deterministic draw/discard turns through wall exhaustion. Spectators receive public tiles and concealed counts only. Canonical state, hash-linked events, actor-scoped command receipts, viewer-specific snapshots, reconnects, schema migration, and replay verification all survive forced Durable Object eviction.

Milestone 1 still requires credentialed deployment smoke evidence through Discord's proxy on desktop/web and mobile; that external evidence is tracked separately from the completed local implementation.

Claims, kongs, winning hands, and scoring remain gated to later milestones.

## Planning documents

- [Implementation roadmap](docs/roadmap.md)
- [Technical baseline](docs/architecture/technical-baseline.md)
- [Hong Kong v1 rules decision register](docs/rules/hong-kong-v1/decision-register.md)
- [Accepted Hong Kong v1 profile](docs/rules/hong-kong-v1/README.md)
- [Testing strategy](docs/testing-strategy.md)
- [Risk register](docs/risk-register.md)
- [Open technical and product decisions](docs/open-questions.md)
- [Contribution workflow](CONTRIBUTING.md)

The roadmap is the source of truth for sequence and status. The rules decision register is the source of truth for game semantics. Implementation must not rely on undocumented rules defaults.

## Fixed product boundaries

The first release is a private, four-seat Hong Kong Mahjong game with spectators, reconnect support, full-hand scoring explanations, and virtual scores. It excludes public matchmaking, ranking, computer players, monetization, Japanese rules, companion-bot UX/processes, and fully trustless cryptography. A Discord bot API credential is still required for backend Activity Instance verification.

The server is authoritative for ordering and hidden state. Clients receive viewer-specific projections and may independently verify public transitions, scores, and post-hand fairness evidence.

## Local application

Run `corepack pnpm app:dev` for standalone mock mode. See [the Activity application guide](apps/discord-activity/README.md) for Discord-proxied development, required secrets, verification, and the guarded production deployment workflow.
