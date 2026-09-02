# Project documentation

Documentation is part of the implementation contract rather than a retrospective description.

| Document                                                                     | Purpose                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Roadmap](roadmap.md)                                                        | Milestone order, status, gates, and exit evidence                   |
| [Technical baseline](architecture/technical-baseline.md)                     | Runtime topology, trust boundaries, and early compatibility choices |
| [Repository layout](architecture/repository-layout.md)                       | Intended package/runtime ownership without empty scaffolding        |
| [Session and request security](architecture/session-and-request-security.md) | OAuth, cookie, CSRF, origin, and WebSocket authorization boundaries |
| [HK v1 decision register](rules/hong-kong-v1/decision-register.md)           | Every variant-dependent game rule and its decision status           |
| [HK v1 accepted profile](rules/hong-kong-v1/README.md)                       | Selected setup, play, winning, scoring, and payment semantics       |
| [Testing strategy](testing-strategy.md)                                      | Required test layers and CI tiers                                   |
| [Risk register](risk-register.md)                                            | Delivery risks, mitigations, triggers, and owners                   |
| [Open questions](open-questions.md)                                          | Non-rules decisions, recommendations, and required-by gates         |
| [Milestones 5–6 plan](implementation-plans/milestones-5-6.md)                | Frozen claims, deadlines, winning, scoring, and delivery contract   |

As implementation begins, accepted architectural choices should become numbered ADRs under `docs/decisions/`. Directories should be added only when they contain an owned artifact or executable code.

Initial accepted choices are indexed in [architecture decisions](decisions/README.md).
