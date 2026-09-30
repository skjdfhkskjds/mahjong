import { describe, expect, it } from "vitest";
import { productionBuildFailures } from "./validate-production-build.js";

const validConfig = {
  name: "mahjong-discord-activity-production",
  vars: {
    APP_MODE: "discord",
    SESSION_COOKIE_NAME: "__Host-mahjong_session",
  },
  durable_objects: {
    bindings: [
      { name: "ACTIVITY_INSTANCE", class_name: "ActivityInstance" },
      { name: "TABLE_ROOM", class_name: "TableRoom" },
    ],
  },
  exports: {
    ActivityInstance: { type: "durable-object", storage: "sqlite" },
    TableRoom: { type: "durable-object", storage: "sqlite" },
  },
};

describe("production deployment build guard", () => {
  it("accepts the production Worker with both SQLite namespaces", () => {
    expect(productionBuildFailures(validConfig)).toEqual([]);
  });

  it("rejects a mock build before the destructive reset", () => {
    expect(
      productionBuildFailures({
        ...validConfig,
        name: "mahjong-discord-activity",
        vars: {
          APP_MODE: "mock",
          SESSION_COOKIE_NAME: "mahjong_session",
          SESSION_SIGNING_KEY:
            "mock-mode-only-signing-key-change-before-deployment",
        },
      }),
    ).toContain("Build must target the production Worker.");
  });

  it("rejects missing storage bindings before the destructive reset", () => {
    expect(
      productionBuildFailures({
        ...validConfig,
        durable_objects: { bindings: [] },
      }),
    ).toContain("Built Worker is missing the TABLE_ROOM binding.");
  });
});
