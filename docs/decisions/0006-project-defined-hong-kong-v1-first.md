# ADR 0006: Project-defined Hong Kong v1 first

Status: accepted

Date: 2026-08-23

## Context

Hong Kong Mahjong conventions vary, and Japanese Mahjong has a materially different state machine and scoring model.

## Decision

Implement an explicitly selected, versioned `hong-kong/v1` profile. Record each variant choice and fixtures before affected code. Add Japanese rules only after Hong Kong matches are reliable.

## Consequences

The product does not claim a universal Hong Kong ruleset. Semantic fixture changes require a new profile version. Shared core remains small instead of accumulating fields for hypothetical variants.
