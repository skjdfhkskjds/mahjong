import { z } from "zod";

export const hongKongProfileSchema = z.strictObject({
  profileId: z.literal("hong-kong/v1"),
  ruleset: z.strictObject({
    id: z.literal("hong-kong"),
    version: z.literal(1),
    status: z.literal("accepted"),
  }),
  decisions: z.tuple([
    z.literal("HK-001"),
    z.literal("HK-002"),
    z.literal("HK-003"),
    z.literal("HK-004"),
    z.literal("HK-005"),
    z.literal("HK-006"),
    z.literal("HK-007"),
    z.literal("HK-008"),
    z.literal("HK-009"),
    z.literal("HK-010"),
    z.literal("HK-011"),
    z.literal("HK-013"),
  ]),
  tileSet: z.strictObject({
    totalTiles: z.literal(144),
    suitedCopies: z.literal(4),
    honorCopies: z.literal(4),
    seasons: z.literal(4),
    flowers: z.literal(4),
    bonusesEnabled: z.literal(true),
    canonicalTileIdOrder: z.literal("v1-suits-honors-seasons-flowers"),
  }),
  seating: z.strictObject({
    turnOrder: z.tuple([
      z.literal("east"),
      z.literal("south"),
      z.literal("west"),
      z.literal("north"),
    ]),
    dealerSeat: z.literal("east"),
    initialDealerSelection: z.literal("uniform-random-table-position"),
  }),
  wall: z.strictObject({
    representation: z.literal("deterministically-shuffled-linear-sequence"),
    simulateDiceBreak: z.literal(false),
    ordinaryDrawEnd: z.literal("head"),
    bonusReplacementDrawEnd: z.literal("tail"),
    deadWall: z.literal("none"),
    emptyWhen: z.literal("head-passes-tail"),
    exhaustiveDrawTrigger: z.literal("required-draw-unavailable"),
  }),
  deal: z.strictObject({
    packetSize: z.literal(4),
    packetRounds: z.literal(3),
    finalDrawOrder: z.tuple([
      z.literal("east"),
      z.literal("east"),
      z.literal("south"),
      z.literal("west"),
      z.literal("north"),
    ]),
    initialTileSlots: z.strictObject({
      east: z.literal(14),
      south: z.literal(13),
      west: z.literal(13),
      north: z.literal(13),
    }),
  }),
  bonusReplacement: z.strictObject({
    initialSeatOrder: z.tuple([
      z.literal("east"),
      z.literal("south"),
      z.literal("west"),
      z.literal("north"),
    ]),
    initialBonusOrder: z.literal("deal-acquisition-order"),
    completeSeatBeforeNext: z.literal(true),
    completeReplacementChainBeforeNextBonus: z.literal(true),
    recursivelyReplaceBonuses: z.literal(true),
    replacementSource: z.literal("tail"),
    exposeImmediately: z.literal(true),
    failedReplacement: z.literal("exhaustive-draw"),
    requiredStructuralTiles: z.strictObject({
      east: z.literal(14),
      south: z.literal(13),
      west: z.literal(13),
      north: z.literal(13),
    }),
  }),
  ordinaryTurn: z.strictObject({
    dealerOpensByDiscarding: z.literal(true),
    drawSource: z.literal("head"),
    replaceDrawnBonusesRecursively: z.literal(true),
    discardStructuralTiles: z.literal(1),
    structuralTilesBetweenTurns: z.literal(13),
    structuralTilesBeforeDiscard: z.literal(14),
    advanceAfterUnclaimedDiscard: z.literal("next-seat-in-turn-order"),
  }),
});

export type HongKongProfile = z.infer<typeof hongKongProfileSchema>;

export function parseHongKongProfile(value: unknown): HongKongProfile {
  return hongKongProfileSchema.parse(value);
}
