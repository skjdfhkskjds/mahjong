import { readFileSync } from "node:fs";

const BUILD_CONFIG_PATH = "dist/mahjong_discord_activity/wrangler.json";

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function productionBuildFailures(config: unknown): readonly string[] {
  const failures: string[] = [];
  const worker = record(config);
  const vars = record(worker?.["vars"]);
  const bindings = record(worker?.["durable_objects"])?.["bindings"];
  const exports = record(worker?.["exports"]);

  if (worker?.["name"] !== "mahjong-discord-activity-production") {
    failures.push("Build must target the production Worker.");
  }
  if (vars?.["APP_MODE"] !== "discord") {
    failures.push("Built Worker APP_MODE must be discord.");
  }
  if (vars?.["SESSION_COOKIE_NAME"] !== "__Host-mahjong_session") {
    failures.push("Built Worker must use the production session cookie.");
  }
  if (vars?.["SESSION_SIGNING_KEY"] !== undefined) {
    failures.push("Built Worker must not contain the mock signing key.");
  }
  for (const [bindingName, className] of [
    ["ACTIVITY_INSTANCE", "ActivityInstance"],
    ["TABLE_ROOM", "TableRoom"],
  ] as const) {
    if (
      !Array.isArray(bindings) ||
      !bindings.some((binding: unknown) => {
        const entry = record(binding);
        return (
          entry?.["name"] === bindingName && entry["class_name"] === className
        );
      })
    ) {
      failures.push(`Built Worker is missing the ${bindingName} binding.`);
    }
    const exportedClass = record(exports?.[className]);
    if (
      exportedClass?.["type"] !== "durable-object" ||
      exportedClass["storage"] !== "sqlite"
    ) {
      failures.push(`Built Worker is missing the ${className} SQLite export.`);
    }
  }
  return failures;
}

if (process.argv[1]?.endsWith("validate-production-build.ts")) {
  const failures = productionBuildFailures(
    JSON.parse(readFileSync(BUILD_CONFIG_PATH, "utf8")) as unknown,
  );
  if (failures.length > 0) {
    console.error("Production build is invalid:");
    for (const failure of failures) console.error(`- ${failure}`);
    console.error("No reset or deployment was attempted.");
    process.exitCode = 1;
  }
}
