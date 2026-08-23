# Mahjong Activity

A four-player Hong Kong Mahjong Discord Activity, built as a TypeScript monorepo and deployed as a React client plus Cloudflare Worker and Durable Objects.

## Status

Milestone 0B is complete. Milestone 1 is implemented and verified locally: the repository now contains a React Activity client, same-origin Worker API, real/mock Discord adapters, signed application sessions, Discord OAuth exchange, and an authenticated hibernatable `TableRoom` WebSocket that survives forced eviction. Closing Milestone 1 still requires credentialed deployment and smoke tests through Discord's proxy on desktop/web and mobile.

The first production-shaped milestone is four authenticated Discord users joining one persistent table, choosing seats, receiving distinct private hands, playing several draw/discard turns, reconnecting, and surviving Durable Object eviction.

## Planning documents

- [Implementation roadmap](docs/roadmap.md)
- [Technical baseline](docs/architecture/technical-baseline.md)
- [Hong Kong v1 rules decision register](docs/rules/hong-kong-v1/decision-register.md)
- [Provisional Hong Kong v1 profile](docs/rules/hong-kong-v1/README.md)
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
