import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  unstable_getVarsForDev as getVarsForDev,
  unstable_readConfig as readWranglerConfig,
} from "wrangler";

import { soloWorkerConfig } from "./solo-worker-config.js";

describe("isolated solo Worker configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("isolates mock defaults from production selection and local credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "mahjong-solo-config-test-"));
    let dispose: (() => void) | undefined;
    try {
      const configPath = join(directory, "wrangler.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          name: "solo-config-test",
          main: "worker.ts",
          compatibility_date: "2026-08-23",
          vars: { APP_MODE: "mock", SESSION_SIGNING_KEY: "mock-test-key" },
          env: { production: { vars: { APP_MODE: "discord" } } },
        }),
      );
      writeFileSync(
        join(directory, ".dev.vars"),
        "APP_MODE=discord\nSESSION_SIGNING_KEY=local-test-key\nDISCORD_BOT_TOKEN=local-test-token\n",
      );
      vi.stubEnv("CLOUDFLARE_ENV", "production");
      vi.stubEnv("APP_MODE", "discord");
      vi.stubEnv("SESSION_SIGNING_KEY", "environment-test-key");
      vi.stubEnv("DISCORD_BOT_TOKEN", "environment-test-token");
      const worker = soloWorkerConfig(configPath);
      dispose = worker.dispose;
      const config: unknown = readWranglerConfig({
        config: worker.path,
        env: "",
      });
      const vars = { APP_MODE: "mock", SESSION_SIGNING_KEY: "mock-test-key" };
      expect(config).toMatchObject({
        main: join(directory, "worker.ts"),
        vars,
        secrets: { required: [] },
      });
      expect(dirname(worker.path)).not.toBe(directory);
      expect(
        getVarsForDev(worker.path, undefined, vars, "production", true, {
          required: [],
        }),
      ).toEqual({
        APP_MODE: { type: "plain_text", value: "mock" },
        SESSION_SIGNING_KEY: { type: "plain_text", value: "mock-test-key" },
      });
      worker.dispose();
      expect(existsSync(dirname(worker.path))).toBe(false);
    } finally {
      dispose?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
