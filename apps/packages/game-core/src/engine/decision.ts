import type { RuleViolation } from "./violation.js";

export type NonEmptyReadonlyArray<Value> = readonly [Value, ...Value[]];

export type Decision<Event> =
  | {
      readonly accepted: true;
      readonly events: NonEmptyReadonlyArray<Event>;
    }
  | {
      readonly accepted: false;
      readonly violations: NonEmptyReadonlyArray<RuleViolation>;
    };

export function accept<Event>(
  first: Event,
  ...remaining: readonly Event[]
): Decision<Event> {
  return { accepted: true, events: [first, ...remaining] };
}

export function reject(
  first: RuleViolation,
  ...remaining: readonly RuleViolation[]
): Decision<never> {
  return { accepted: false, violations: [first, ...remaining] };
}
