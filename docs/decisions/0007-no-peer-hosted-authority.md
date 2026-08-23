# ADR 0007: No peer-hosted authority

Status: accepted

Date: 2026-08-23

## Context

Discord Activities do not support WebRTC, so browsers require a relay. Deterministic peer lockstep would expose hidden information or demand substantially more cryptography.

## Decision

Do not elect a participant as host and do not distribute the complete wall during play. Route WebSockets to the authoritative `TableRoom`. Add collaborative entropy and post-hand auditability incrementally.

## Consequences

Availability and secrecy depend on the Cloudflare service during play. Participants can verify outcomes but do not establish canonical ordering or eliminate all server trust.
