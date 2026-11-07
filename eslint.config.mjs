import js from "@eslint/js";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

const prismaClientMessage = "Use createPrismaClient() from apps/api/src/database/create-prisma-client.ts.";
const workspacePackageMessage = "apps/api can only use `import type` from workspace packages (they have no runtime build yet).";
const prismaRestrictedPaths = [{ name: "@prisma/client", importNames: ["PrismaClient"], allowTypeImports: true, message: prismaClientMessage }];
const prismaRestrictedPatterns = [
  { group: ["**/generated/prisma/*"], importNames: ["PrismaClient"], allowTypeImports: true, message: prismaClientMessage },
];

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/coverage/**", "**/next-env.d.ts", "apps/api/src/generated/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Next.js recommended rules (incl. React/hooks), scoped to the web app only.
  ...nextCoreWebVitals.map((config) => ({
    ...config,
    files: ["apps/web/**/*.{js,jsx,mjs,ts,tsx}"],
    settings: { ...config.settings, next: { rootDir: "apps/web/" } },
  })),
  // PrismaClient só pode ser criado por createPrismaClient (fixa TimeZone=UTC; ver docs/database.md).
  {
    ignores: ["apps/api/src/database/create-prisma-client.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='PrismaClient']", message: prismaClientMessage },
      ],
      "@typescript-eslint/no-restricted-imports": ["error", { paths: prismaRestrictedPaths, patterns: prismaRestrictedPatterns }],
    },
  },
  // A API compila com tsc e roda o dist no Node: os packages exportam .ts sem build, então só `import type` é seguro
  // (o import de valor passa no typecheck e quebra em runtime). Repete as regras do Prisma: flat config substitui a regra.
  {
    files: ["apps/api/**/*.ts"],
    ignores: ["apps/api/src/database/create-prisma-client.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: prismaRestrictedPaths,
          patterns: [
            ...prismaRestrictedPatterns,
            { group: ["@erp/*"], allowTypeImports: true, message: workspacePackageMessage },
          ],
        },
      ],
    },
  },
);
