import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packagesDirectory = resolve(repositoryRoot, "packages");

interface PackageManifest {
  readonly name?: unknown;
  readonly private?: unknown;
  readonly type?: unknown;
  readonly exports?: unknown;
}

const violations: string[] = [];

if (existsSync(packagesDirectory)) {
  for (const entry of readdirSync(packagesDirectory)) {
    const directory = resolve(packagesDirectory, entry);
    if (!statSync(directory).isDirectory()) continue;

    const manifestPath = resolve(directory, "package.json");
    if (!existsSync(manifestPath)) {
      violations.push(`${entry}: missing package.json`);
      continue;
    }

    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as PackageManifest;
    if (manifest.name !== `@mahjong/${entry}`)
      violations.push(`${entry}: package name must be @mahjong/${entry}`);
    if (manifest.private !== true)
      violations.push(
        `${entry}: workspace packages must remain private before publication is intentional`,
      );
    if (manifest.type !== "module")
      violations.push(`${entry}: package type must be module`);
    if (
      JSON.stringify(manifest.exports) !==
      JSON.stringify({ ".": "./src/index.ts" })
    ) {
      violations.push(
        `${entry}: exports must expose only ./src/index.ts during Milestone 0B`,
      );
    }
    if (!existsSync(resolve(directory, "src/index.ts")))
      violations.push(`${entry}: exported src/index.ts does not exist`);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Package exports are valid.");
}
