export {
  hongKongProfileSchema,
  parseHongKongProfile,
} from "./profile/hong-kong-profile.js";
export type { HongKongProfile } from "./profile/hong-kong-profile.js";
export { hongKongV1Profile } from "./profile/hong-kong-v1.js";
export { initialDealSeatOrder } from "./setup/initial-deal.js";
export {
  applyGameCommand,
  applyGameCommandV1,
  assertCheckpointMatchesReplay,
  assertGameInvariants,
  canonicalEventHashPayload,
  canonicalGameEventJson,
  canonicalGameJson,
  decodeCanonicalGameEventJson,
  decodeCanonicalGameJson,
  decideReactionExpiration,
  decideGameCommand,
  decideGameCommandV1,
  projectGame,
  projectGameV1,
  reduceGameEvent,
  replayGameEvents,
  startHongKongV1Game,
} from "./engine/draw-discard-game.js";
export type {
  CanonicalGameState,
  CanonicalGameStateV1,
  CanonicalPlayerState,
  CanonicalPlayerStateV1,
  CompletionProvenance,
  GameDecision,
  GameDecisionV1,
  GamePhase,
  GameView,
  GameViewV1,
  HandCompletedEvent,
  HongKongGameCommand,
  HongKongGameCommandV1,
  HongKongGameEvent,
  HongKongGameEventV1,
  NonEmptyGameEventBatch,
  PlayerReactionResponse,
  PublicMeld,
  PublicTile,
  ReactionResponse,
  ReactionWindow,
  SeatMap,
  SelfWinDeclaredEvent,
} from "./engine/draw-discard-game.js";
export type {
  CompletedHandResult,
  WinningPhysicalHand,
} from "./engine/draw-discard-game.js";
export {
  assertCompletedHandResult,
  resolveScoredReactionWinner,
  scoreReactionWinCandidate,
  scoreSelfWinCandidate,
} from "./engine/draw-discard-game.js";
export {
  isLegalReaction,
  isStructurallyWinningWith,
  legalReactionsForSeat,
  reactionKey,
} from "./claims/legal-reactions.js";
export { normalizeReactionWindow } from "./claims/reaction-resolution.js";
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
export {
  awardPatterns,
  patternSuppressionGraph,
  validatePatternInteractionGraph,
} from "./scoring/award-patterns.js";
export type {
  PatternAwards,
  PatternSuppressionEdge,
  SuppressedPattern,
} from "./scoring/award-patterns.js";
export { decomposeWinningHand } from "./scoring/decompose-hand.js";
export type {
  HandDecomposition,
  ScoringMeld,
} from "./scoring/decompose-hand.js";
export { detectPatterns, patternCatalog } from "./scoring/detect-patterns.js";
export type {
  DetectedPattern,
  PatternCategory,
  PatternId,
} from "./scoring/detect-patterns.js";
export {
  createScoringHandFixture,
  scoringTileId,
} from "./scoring/hand-fixture.js";
export type {
  ScoringHandFixture,
  ScoringHandFixtureInput,
  WinningConditions,
  WinningTileSource,
} from "./scoring/hand-fixture.js";
export { calculatePayments, halfSpicyPoints } from "./scoring/payments.js";
export type { SeatPayments } from "./scoring/payments.js";
export { scoreDecomposition, scoreHongKongHand } from "./scoring/score-hand.js";
export type {
  HongKongHandScore,
  ScoredDecomposition,
} from "./scoring/score-hand.js";
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
export { hongKongGameEngine } from "./engine/hong-kong-engine.js";
export type { HongKongEngineResult } from "./engine/hong-kong-engine.js";
export type {
  HongKongMoveError,
  HongKongMoveOutcome,
  HongKongReactionOutcome,
  HongKongResolution,
  HongKongSubmission,
  HongKongTurnStage,
  KongReplacement,
} from "./engine/hong-kong-policy-outcomes.js";
