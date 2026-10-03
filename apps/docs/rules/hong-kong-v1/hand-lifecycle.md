# Foundational hand lifecycle

This document records the accepted foundational setup, bonus replacement,
ordinary draw/discard, and exhaustion behavior. Claims, kongs, and scoring now
continue this lifecycle under the frozen
[Milestones 5–6 plan](../../implementation-plans/milestones-5-6.md).

## Seat assignment

The room supplies four stable player positions. Match randomness selects one initial dealer uniformly; that position receives East. Moving counter-clockwise assigns South, West, then North. Seat winds may rotate between later hands; stable table positions do not.

## Wall

The deterministic shuffle produces `wall[0..143]`:

- `head` points to the next ordinary draw.
- `tail` points to the next bonus replacement. Kong replacement behavior remains open.
- A successful draw advances its corresponding cursor inward.
- The wall has no fixed dead-wall reservation.
- `head > tail` means that no future draw is available.

Dice, four physical sides, the physical break, stacked-tile orientation, and East's physical jumping pickup are not simulated.

## Initial deal

Consume from the head in this exact order:

```text
East×4, South×4, West×4, North×4
East×4, South×4, West×4, North×4
East×4, South×4, West×4, North×4
East, East, South, West, North
```

This consumes 53 tiles and initially assigns East 14 tile slots and every other seat 13. A dealt bonus occupies a slot temporarily but is not a structural concealed tile.

## Initial bonus replacement

Process East, South, West, then North. For one seat, retain the acquisition order of bonuses from the 53-step deal. For each original bonus in that order:

1. Expose the bonus publicly.
2. Draw its replacement from the tail.
3. If the replacement is another bonus, expose it and draw again immediately.
4. Complete that recursive replacement chain before processing the next originally dealt bonus.

Finish the current seat before moving to the next. Replacement completes when East has 14 structural tiles and every other seat has 13. If a required replacement does not exist, end as an exhaustive draw; later exhaustive-draw consequences are still unresolved.

## Ordinary play

East opens by discarding one structural tile without drawing. After an unclaimed discard, advance to the next seat in East–South–West–North order.

On an ordinary turn:

1. Draw from the head.
2. Expose a drawn bonus and recursively replace from the tail until a structural tile arrives.
3. If the wall cannot supply a required replacement, end as an exhaustive draw.
4. Otherwise, absent a win or other self-action added in later milestones, discard exactly one structural tile.

A player normally has 13 structural tiles between turns and 14 immediately before discarding. Bonus tiles are public, cannot be discarded, and never count toward the structural total.

Drawing the final available structural tile is successful: the active player
receives the accepted win/kong self-action opportunity and, if none ends the
hand, discards normally. That discard opens the accepted eight-second reaction
window and may still be claimed as the last discard. The hand becomes exhaustive
only when subsequent play requires an ordinary, bonus-replacement, or
kong-replacement draw and no tile is available.

## Claims and meld turns

Every discard opens a reaction window before turn order advances. An unclaimed
discard advances to the next seat's ordinary draw. A chow or pung claim makes
the claimant active and requires a discard without a head draw. An exposed kong
claim instead draws and recursively replaces from the tail before the claimant
discards. Claimed physical tiles leave the discard location and become part of
an immutable public meld.

Concealed and added kongs are self-actions before discard. A concealed kong
commits immediately; an added kong first opens its robbing window. Every
committed kong uses the same tail and recursive bonus-replacement boundary as
the rest of `hong-kong/v1`.

A legal self-draw, discard, or robbed-kong win ends the hand with one scored
result. Match continuation after `complete`, and continuation after `exhausted`,
remain Milestone 7 concerns.
