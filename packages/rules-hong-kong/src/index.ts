export {
  hongKongProfileSchema,
  parseHongKongProfile,
} from "./profile/hong-kong-profile.js";
export type { HongKongProfile } from "./profile/hong-kong-profile.js";
export { hongKongV1Profile } from "./profile/hong-kong-v1.js";
export { initialDealSeatOrder } from "./setup/initial-deal.js";
export {
  applyGameCommand,
  applyGameCommandV2,
  assertGameInvariants,
  canonicalEventHashPayload,
  canonicalGameEventJson,
  canonicalGameJson,
  canonicalVersionedEventHashPayload,
  canonicalVersionedGameJson,
  canonicalVersionedGameEventJson,
  decodeCanonicalGameEventJson,
  decodeCanonicalGameJson,
  decodeCanonicalVersionedGameEventJson,
  decodeCanonicalVersionedGameJson,
  decideReactionExpiration,
  decideGameCommand,
  decideGameCommandV2,
  projectGame,
  projectGameV2,
  projectLegacyCompatibleGameV2,
  reduceGameEvent,
  reduceVersionedGameEvent,
  replayGameEvents,
  replayVersionedGameEvents,
  startHongKongV1Game,
  startHongKongV2Game,
  createStateUpgradeEvent,
  upgradeCanonicalGameState,
} from "./engine/draw-discard-game.js";
export type {
  CanonicalGameState,
  CanonicalGameStateV1,
  CanonicalGameStateV2,
  CanonicalPlayerState,
  CanonicalPlayerStateV1,
  CanonicalPlayerStateV2,
  GameDecision,
  GameDecisionV2,
  GamePhase,
  GameView,
  GameViewV2,
  HongKongGameCommand,
  HongKongGameCommandV2,
  HongKongGameEvent,
  HongKongGameEventV2,
  LegacyUpgradeProvenance,
  NonEmptyGameEventBatch,
  PlayerReactionResponse,
  PublicMeld,
  PublicTile,
  ReactionResponse,
  ReactionWindow,
  SeatMap,
  StateUpgradedEvent,
  VersionedHongKongGameEvent,
  VersionedCanonicalGameState,
} from "./engine/draw-discard-game.js";
export {
  isLegalReaction,
  isStructurallyWinningWith,
  legalReactionsForSeat,
  reactionKey,
} from "./claims/legal-reactions.js";
export {
  allRespondersSubmitted,
  normalizeReactionWindow,
} from "./claims/reaction-resolution.js";
export type {
  NormalizedReaction,
  ReactionOutcome,
  ReactionResolution,
} from "./claims/reaction-resolution.js";
export {
  legalAddedKongs,
  legalConcealedKongs,
  replacementFromTail,
} from "./kongs/kong-transitions.js";
export type { ReplacementOutcome } from "./kongs/kong-transitions.js";
export { canonicalTileIds, meldStructuralSize } from "./melds/meld.js";
export type {
  DeclaredMeld,
  KongKind,
  MeldExposure,
  MeldKind,
} from "./melds/meld.js";
export { bonusTileKinds, flowers, seasons } from "./tiles/bonus-tile-kind.js";
export type { BonusTileKind, Flower, Season } from "./tiles/bonus-tile-kind.js";
export type { HongKongTileKind } from "./tiles/hong-kong-tile-kind.js";
export { createHongKongV1TileSet } from "./wall/create-tile-set.js";
export {
  deterministicShuffle,
  HONG_KONG_V1_RANDOM_BYTES,
  HONG_KONG_V1_SHUFFLE_ALGORITHM,
  selectInitialDealerPosition,
} from "./wall/deterministic-shuffle.js";
