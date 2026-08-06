import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local timestamped backups — must not pollute Problems / lint.
    ".checkpoints/**",
    "**/*.backup",
  ]),
  // Underscore-prefixed unused args/vars are intentional across the app.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  /**
   * app/page.tsx is a large client monolith (localStorage hydrate, estimator
   * dirty tracking, theme sync, map refs). React Compiler eslint rules flag
   * those legitimate patterns; keep them strict for smaller modules/components.
   */
  {
    files: ["app/page.tsx"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
      "react-hooks/immutability": "off",
      // Monolith intentionally omits unstable callbacks from effect deps.
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    files: ["components/RoofTracer.tsx"],
    rules: {
      // Leaflet's dynamic import + imperative map API needs a flexible handle.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
