import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstable_readConfig as readWranglerConfig } from "wrangler";

/** Keep Discord .dev.vars and existing local storage out of solo sessions. */
export function soloWorkerConfig(configPath: string): {
  path: string;
  dispose: () => void;
} {
  // Validate this third-party result before copying its configuration fields.
  // An explicit empty environment selects the committed top-level mock config,
  // even when the caller's shell normally selects the production environment.
  const value: unknown = readWranglerConfig({ config: configPath, env: "" });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid base Worker configuration.");
  }
  const base = value as Record<string, unknown>;
  const vars = base["vars"];
  if (
    typeof vars !== "object" ||
    vars === null ||
    !("APP_MODE" in vars) ||
    vars.APP_MODE !== "mock"
  ) {
    throw new Error(
      "The base Worker configuration must provide mock defaults.",
    );
  }
  const directory = mkdtempSync(join(tmpdir(), "mahjong-solo-"));
  const path = join(directory, "wrangler.json");
  writeFileSync(
    path,
    JSON.stringify({
      name: base["name"],
      main: base["main"],
      compatibility_date: base["compatibility_date"],
      compatibility_flags: base["compatibility_flags"],
      durable_objects: base["durable_objects"],
      exports: base["exports"],
      assets: base["assets"],
      vars,
      secrets: { required: [] },
    }),
  );
  // A local file overrides environment inference without loading any secrets.
  writeFileSync(
    join(directory, ".dev.vars"),
    "# Solo mode uses committed mock defaults.\n",
  );
  return {
    path,
    dispose: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
