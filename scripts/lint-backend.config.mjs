// Ad-hoc lint config for the JS backend (the main eslint.config.js only lints
// ts/tsx). Catches undefined identifiers after refactors:
//   npx eslint --no-config-lookup -c scripts/lint-backend.config.mjs src/backend
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        WebSocket: "readonly",
        Response: "readonly",
        Headers: "readonly",
        Request: "readonly",
        fetch: "readonly",
        ReadableStream: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        crypto: "off",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
      "no-empty": "off",
      "no-control-regex": "off",
      "require-yield": "off",
    },
  },
];
