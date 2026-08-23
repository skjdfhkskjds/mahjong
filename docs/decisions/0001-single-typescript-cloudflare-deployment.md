# ADR 0001: Single TypeScript Cloudflare deployment

Status: accepted

Date: 2026-08-23

## Context

The Activity needs a frontend, HTTP authentication/API, persistent coordination, and real-time transport without a separately operated server stack.

## Decision

Use one TypeScript monorepo. Deploy the React static assets and Worker API together through Cloudflare's Vite tooling. Use SQLite-backed Durable Objects for stateful coordination. Configuration and SQL embedded in TypeScript migrations are expected non-TypeScript artifacts.

## Consequences

The Activity has one proxied origin and one deployment lifecycle. Pure domain code can run in browser and Worker. The project accepts Cloudflare platform coupling at runtime and must test in the Workers runtime.
