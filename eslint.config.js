import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-coercion": "error",
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    // The bar the app's own code is held to. Tests may be long and repetitive, and fake async calls.
    files: ["server/**/*.js", "public/**/*.js"],
    rules: {
      complexity: ["error", 12],
      "max-depth": ["error", 3],
      "max-lines": ["error", { max: 200, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
      "max-nested-callbacks": ["error", 3],
      "max-params": ["error", 5],
      "no-nested-ternary": "error",
      "no-shadow": "error",
      "require-await": "error",
    },
  },
];
