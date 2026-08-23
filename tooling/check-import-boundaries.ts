import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "..");

const dependencyRules: Readonly<Record<string, readonly string[]>> = {
  "game-core": [],
  "rules-hong-kong": ["game-core"],
  protocol: ["game-core"],
  fairness: ["game-core"],
  testkit: ["game-core", "rules-hong-kong", "protocol", "fairness"],
};

const sourceRoots = [
  resolve(repositoryRoot, "packages"),
  resolve(repositoryRoot, "apps"),
];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

function walk(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return [...sourceExtensions].some((extension) => path.endsWith(extension))
      ? [path]
      : [];
  });
}

function workspaceArea(path: string):
  | {
      readonly type: "app" | "package";
      readonly name: string;
      readonly side?: "client" | "worker";
    }
  | undefined {
  const segments = relative(repositoryRoot, path).split(sep);
  if (segments[0] === "packages" && segments[1] !== undefined) {
    return { type: "package", name: segments[1] };
  }
  if (segments[0] === "apps" && segments[1] !== undefined) {
    const sourceIndex = segments.indexOf("src");
    const side = segments[sourceIndex + 1];
    return {
      type: "app",
      name: segments[1],
      ...(side === "client" || side === "worker" ? { side } : {}),
    };
  }
  return undefined;
}

function importedWorkspacePackage(specifier: string): string | undefined {
  const match = /^@mahjong\/([^/]+)(?:\/(.+))?$/.exec(specifier);
  if (match?.[1] === undefined) return undefined;
  if (match[2] !== undefined) return `${match[1]}/deep-import`;
  return match[1];
}

function resolveRelativeImport(
  fromFile: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const candidate = resolve(dirname(fromFile), specifier);
  const candidates = [
    candidate,
    ...[...sourceExtensions].map((extension) => `${candidate}${extension}`),
  ];
  return candidates.find((path) => existsSync(path));
}

function importSpecifiers(file: string): readonly string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return imports;
}

function violationFor(file: string, specifier: string): string | undefined {
  const source = workspaceArea(file);
  if (source === undefined) return undefined;

  const targetFile = resolveRelativeImport(file, specifier);
  const target =
    targetFile === undefined ? undefined : workspaceArea(targetFile);

  if (source.type === "package" && target?.type === "app") {
    return "packages must not import application source";
  }
  if (
    source.type === "app" &&
    source.side !== undefined &&
    target?.type === "app" &&
    target.side !== undefined &&
    source.side !== target.side
  ) {
    return `${source.side} source must not import ${target.side} source`;
  }

  const workspaceImport = importedWorkspacePackage(specifier);
  if (workspaceImport?.endsWith("/deep-import") === true) {
    return "workspace packages must be imported through a public entry point";
  }
  if (source.type === "package" && workspaceImport !== undefined) {
    const allowed = dependencyRules[source.name] ?? [];
    if (!allowed.includes(workspaceImport)) {
      return `package ${source.name} may not depend on ${workspaceImport}`;
    }
  }

  return undefined;
}

const violations = sourceRoots.flatMap(walk).flatMap((file) =>
  importSpecifiers(file).flatMap((specifier) => {
    const violation = violationFor(file, specifier);
    return violation === undefined
      ? []
      : [`${relative(repositoryRoot, file)}: ${violation} (${specifier})`];
  }),
);

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Import boundaries are valid.");
}
