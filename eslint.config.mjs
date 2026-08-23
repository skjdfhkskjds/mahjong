import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const platformImports = [
  "@discord/*",
  "cloudflare:*",
  "node:*",
  "react",
  "react/*",
  "ws",
];

export default tseslint.config(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: ["packages/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...platformImports.map((group) => ({
              group: [group],
              message: "Pure packages must remain runtime-free.",
            })),
            {
              group: ["apps", "apps/*", "**/apps", "**/apps/*"],
              message: "Pure packages must not import application code.",
            },
            {
              group: ["@mahjong/*/src", "@mahjong/*/src/*"],
              message: "Import another package through a public export.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/game-core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@mahjong/*"],
              message: "game-core must not depend on another project package.",
            },
          ],
        },
      ],
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["**/*.mjs"],
  },
);
