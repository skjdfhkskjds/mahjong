# Agent instructions

These instructions apply repository-wide; a nearer `AGENTS.md` may override or add subtree-specific rules.

## Before editing

- Read [STYLE_GUIDE.md](STYLE_GUIDE.md), [CONTRIBUTING.md](CONTRIBUTING.md), and the relevant README, roadmap section, ADR, security, rules, or testing document.
- Search for an existing pattern before inventing one. Do not assume Mahjong semantics or scaffold code for a future milestone.
- Preserve unrelated user changes and the current checkout. Keep changes small, reviewable, and within the requested scope.

## Boundaries

- `packages/game-core`: minimal variant-neutral, runtime-free contracts.
- `packages/rules-hong-kong`: pure `hong-kong/v1` rules and engine.
- `apps/discord-activity/src/client`: React, Embedded App SDK adapters, transport, and UI.
- `apps/discord-activity/src/worker`: auth, Discord REST, HTTP/WebSocket routing, storage, and Durable Objects.
- Dependencies flow from apps through package public exports; packages never import apps, and client/Worker source never cross-import.
- Boundary tooling catches common violations but not every relative cross-workspace import; review resolved targets as well as specifier spelling.

Keep the server authoritative, validate all external/persisted data, persist before publish, and expose only viewer-safe projections. Never expose or log credentials, serialized session payloads, command bodies, or hidden/canonical game data.

## Making changes

- Follow [STYLE_GUIDE.md](STYLE_GUIDE.md) and let Prettier/ESLint decide formatting.
- When runtime behavior changes, add or update focused tests. Prefer responsibility-based modules over growing coordinators or duplicating wire contracts/validators.
- Add dependencies only when justified; use pnpm and commit the lockfile change.
- Do not hand-edit `apps/discord-activity/src/worker/worker-configuration.d.ts`; regenerate it with `corepack pnpm --filter @mahjong/discord-activity run types:worker` after binding, compatibility-date, or flag changes.
- Rules-semantic changes update the decision register, worked examples, and traceability fixtures.
- Protocol changes document deployment overlap and add wire-compatibility tests. Persisted-format changes prove migration or recovery with retained permanent fixtures, including the oldest supported format.
- Do not deploy, rotate secrets, change external Discord/Cloudflare state, or run credentialed smoke tests unless explicitly requested.

## Verification

- Use Node 24 from `.node-version` and the Corepack-pinned pnpm version. Install with `corepack pnpm install --frozen-lockfile` when needed.
- Run focused tests/typechecks while iterating.
- Run `corepack pnpm check` before handoff.
- Also run `corepack pnpm app:build` for client, Worker, dependency, or build-configuration changes.
- Report commands run and any checks skipped or failing.

Use Conventional Commits if asked to commit. PRs follow [the repository template](.github/pull_request_template.md).
