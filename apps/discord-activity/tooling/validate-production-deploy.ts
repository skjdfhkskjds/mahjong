const CLIENT_ID_PATTERN = /^\d{1,32}$/u;

export function productionDeploymentFailures(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const failures: string[] = [];
  if (environment["VITE_ACTIVITY_MODE"] !== "discord") {
    failures.push("VITE_ACTIVITY_MODE must be discord.");
  }
  if (!CLIENT_ID_PATTERN.test(environment["VITE_DISCORD_CLIENT_ID"] ?? "")) {
    failures.push("VITE_DISCORD_CLIENT_ID must be a Discord snowflake.");
  }
  return failures;
}

const failures = productionDeploymentFailures(process.env);
if (failures.length > 0) {
  console.error("Production deployment configuration is invalid:");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("No build or deployment was attempted.");
  process.exitCode = 1;
}
