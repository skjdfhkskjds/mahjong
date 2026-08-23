import type { Viewer } from "../table/viewer.js";
import {
  assertJsonValue,
  type JsonValue,
} from "../serialization/json-value.js";
import type { Decision } from "./decision.js";
import type { InvariantViolation } from "./violation.js";

export interface RulesetReference {
  readonly id: string;
  readonly version: number;
}

export interface GenesisSnapshot<
  State extends JsonValue,
  Configuration extends JsonValue,
> {
  readonly formatVersion: 1;
  readonly eventSequence: 0;
  readonly ruleset: RulesetReference;
  readonly configuration: Configuration;
  readonly state: State;
}

export interface RulesetEngine<
  State extends JsonValue,
  Command,
  Event extends JsonValue,
  View,
  Configuration extends JsonValue,
  CreateContext,
  CommandContext,
> {
  createGenesis(
    configuration: Readonly<Configuration>,
    context: Readonly<CreateContext>,
  ): GenesisSnapshot<State, Configuration>;

  decide(
    state: Readonly<State>,
    command: Readonly<Command>,
    context: Readonly<CommandContext>,
  ): Decision<Event>;

  evolve(state: Readonly<State>, event: Readonly<Event>): State;

  project(state: Readonly<State>, viewer: Readonly<Viewer>): View;

  assertInvariants(state: Readonly<State>): readonly InvariantViolation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRulesetReference(value: unknown): RulesetReference {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    value["id"].trim().length === 0 ||
    !Number.isSafeInteger(value["version"]) ||
    (value["version"] as number) < 1
  ) {
    throw new TypeError("Genesis snapshot has an invalid ruleset reference.");
  }

  return { id: value["id"], version: value["version"] as number };
}

export function decodeGenesisSnapshot(
  value: unknown,
): GenesisSnapshot<JsonValue, JsonValue> {
  if (
    !isRecord(value) ||
    value["formatVersion"] !== 1 ||
    value["eventSequence"] !== 0
  ) {
    throw new TypeError("Unsupported or invalid genesis snapshot envelope.");
  }

  const ruleset = parseRulesetReference(value["ruleset"]);
  const configuration = value["configuration"];
  const state = value["state"];
  assertJsonValue(configuration, "Genesis configuration");
  assertJsonValue(state, "Genesis state");

  return {
    formatVersion: 1,
    eventSequence: 0,
    ruleset,
    configuration,
    state,
  };
}

export function replayEventTail<State, Event>(
  genesisState: State,
  events: readonly Readonly<Event>[],
  evolve: (state: Readonly<State>, event: Readonly<Event>) => State,
): State {
  return events.reduce<State>(
    (state, event) => evolve(state, event),
    genesisState,
  );
}
