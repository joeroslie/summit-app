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
  ]),
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
