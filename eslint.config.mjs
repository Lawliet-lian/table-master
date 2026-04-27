// ESLint flat config that mirrors `ObsidianReviewBot` so violations can be
// reproduced locally before re-pushing.
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import obsidianmdPkg from "eslint-plugin-obsidianmd";

const obsidianmd = obsidianmdPkg.default ?? obsidianmdPkg;

// Hand-pick rules so we don't have to rely on the plugin's preset format.
const obsidianRules = {};
for (const ruleName of Object.keys(obsidianmd.rules ?? {})) {
  obsidianRules[`obsidianmd/${ruleName}`] = "error";
}

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      obsidianmd,
    },
    rules: {
      ...(tsPlugin.configs?.recommended?.rules ?? {}),
      ...obsidianRules,
      // Disable rules that need full `parserOptions.project` type info we
      // don't wire up here.
      "@typescript-eslint/no-unsafe-function-type": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
