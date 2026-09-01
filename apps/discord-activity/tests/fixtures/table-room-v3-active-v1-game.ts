import { tableRoomV1Schema } from "./table-room-v1-schema.js";

/**
 * Permanent oldest active-game migration fixture.
 *
 * These canonical v1 bytes and hashes were produced before storage schema v4.
 * Never regenerate them from the current encoder. A future storage migration
 * must continue to verify this exact chain before appending newer events.
 */
export const tableRoomV3ActiveV1GameFixture = {
  checkpointStateJson:
    '{"phase":"awaiting-draw","players":{"east":{"actorId":"actor:south","bonuses":[140,141],"discards":[134],"hand":[20,125,6,93,100,4,57,122,34,62,36,98,96],"seat":"east"},"north":{"actorId":"actor:east","bonuses":[136],"discards":[],"hand":[1,64,60,110,38,79,73,44,87,119,14,101,75],"seat":"north"},"south":{"actorId":"actor:west","bonuses":[142],"discards":[],"hand":[74,48,8,58,2,7,10,76,129,72,88,5,97],"seat":"south"},"west":{"actorId":"actor:north","bonuses":[138,137],"discards":[],"hand":[12,108,16,124,22,86,21,31,99,90,50,59,61],"seat":"west"}},"ruleset":"hong-kong/v1","schemaVersion":1,"sequence":2,"shuffleAlgorithm":"random-bytes-rejection-fisher-yates/v1","turn":"south","wall":{"head":53,"order":[134,20,140,6,74,48,8,58,12,108,16,138,1,64,60,136,93,100,4,57,2,7,10,76,22,86,21,31,38,79,73,44,122,141,62,36,129,72,88,5,99,90,50,59,87,119,14,101,98,96,142,137,75,91,19,117,56,121,68,69,104,118,47,105,39,80,78,128,82,71,32,103,54,3,0,49,27,106,102,77,66,81,84,17,70,51,30,13,116,23,127,33,114,120,26,45,11,132,46,89,94,63,95,37,112,131,43,115,53,130,41,126,92,25,52,9,42,123,107,85,15,67,24,29,28,83,139,109,111,55,35,65,135,113,18,133,40,143,110,61,124,97,34,125],"tail":137}}',
  events: [
    {
      eventHash:
        "d589f4c5af7c9328a38a2d5630de04fb670e7dacb2e9ab1e474d487e6705c2b9",
      eventJson:
        '{"sequence":1,"state":{"phase":"awaiting-dealer-discard","players":{"east":{"actorId":"actor:south","bonuses":[140,141],"discards":[],"hand":[134,20,125,6,93,100,4,57,122,34,62,36,98,96],"seat":"east"},"north":{"actorId":"actor:east","bonuses":[136],"discards":[],"hand":[1,64,60,110,38,79,73,44,87,119,14,101,75],"seat":"north"},"south":{"actorId":"actor:west","bonuses":[142],"discards":[],"hand":[74,48,8,58,2,7,10,76,129,72,88,5,97],"seat":"south"},"west":{"actorId":"actor:north","bonuses":[138,137],"discards":[],"hand":[12,108,16,124,22,86,21,31,99,90,50,59,61],"seat":"west"}},"ruleset":"hong-kong/v1","schemaVersion":1,"sequence":1,"shuffleAlgorithm":"random-bytes-rejection-fisher-yates/v1","turn":"east","wall":{"head":53,"order":[134,20,140,6,74,48,8,58,12,108,16,138,1,64,60,136,93,100,4,57,2,7,10,76,22,86,21,31,38,79,73,44,122,141,62,36,129,72,88,5,99,90,50,59,87,119,14,101,98,96,142,137,75,91,19,117,56,121,68,69,104,118,47,105,39,80,78,128,82,71,32,103,54,3,0,49,27,106,102,77,66,81,84,17,70,51,30,13,116,23,127,33,114,120,26,45,11,132,46,89,94,63,95,37,112,131,43,115,53,130,41,126,92,25,52,9,42,123,107,85,15,67,24,29,28,83,139,109,111,55,35,65,135,113,18,133,40,143,110,61,124,97,34,125],"tail":137}},"type":"game/started"}',
      previousHash: null,
      sequence: 1,
    },
    {
      eventHash:
        "2eba8b56c66ed397aa849460eb384ea24b0dda1516b734af9168940e541a4b53",
      eventJson:
        '{"seat":"east","sequence":2,"tileId":134,"type":"game/tile-discarded"}',
      previousHash:
        "d589f4c5af7c9328a38a2d5630de04fb670e7dacb2e9ab1e474d487e6705c2b9",
      sequence: 2,
    },
  ],
  lastEventHash:
    "2eba8b56c66ed397aa849460eb384ea24b0dda1516b734af9168940e541a4b53",
  lobbyStateVersion: 9,
  schema: [
    ...tableRoomV1Schema,
    "CREATE TABLE lobby_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_version INTEGER NOT NULL CHECK (state_version >= 0))",
    "CREATE TABLE lobby_seats (seat TEXT PRIMARY KEY CHECK (seat IN ('east', 'south', 'west', 'north')), actor_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, ready INTEGER NOT NULL CHECK (ready IN (0, 1)))",
    "CREATE TABLE lobby_command_receipts (command_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL)",
    "CREATE TABLE canonical_game_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_json TEXT NOT NULL, last_event_hash TEXT NOT NULL)",
    "CREATE TABLE game_events (sequence INTEGER PRIMARY KEY CHECK (sequence >= 1), event_json TEXT NOT NULL, previous_hash TEXT, event_hash TEXT NOT NULL UNIQUE)",
  ],
  schemaVersion: 3,
  tableId: "fixture-v3-active-v1",
} as const;
