import { createStringIdentifier, type Brand } from "./brand.js";

export type PlayerId = Brand<string, "PlayerId">;
export type TableId = Brand<string, "TableId">;
export type HandId = Brand<string, "HandId">;
export type CommandId = Brand<string, "CommandId">;

export const playerId = createStringIdentifier("PlayerId");
export const tableId = createStringIdentifier("TableId");
export const handId = createStringIdentifier("HandId");
export const commandId = createStringIdentifier("CommandId");
