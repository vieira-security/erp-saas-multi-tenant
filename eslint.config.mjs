import js from "@eslint/js";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/coverage/**", "**/next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Next.js recommended rules (incl. React/hooks), scoped to the web app only.
  ...nextCoreWebVitals.map((config) => ({
    ...config,
    files: ["apps/web/**/*.{js,jsx,mjs,ts,tsx}"],
    settings: { ...config.settings, next: { rootDir: "apps/web/" } },
  })),
);
