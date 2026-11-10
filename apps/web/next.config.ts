import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { apiProxyRewrites, resolveApiUrl } from "./src/config/api-proxy";

const MOCK_FETCH_MODULE = fileURLToPath(new URL("./src/lib/api/mocks/mock-fetch.ts", import.meta.url));

const nextConfig: NextConfig = {
  // Os packages exportam TypeScript sem build; o web importa valores (constantes) de @erp/contracts.
  transpilePackages: ["@erp/contracts"],
  // O `next dev` rodado por agentes de IA gera AGENTS.md/CLAUDE.md no app; as instruções do repo ficam na raiz.
  agentRules: false,
  // O contracts usa imports relativos `./x.js` apontando para `.ts` (exigido pelo NodeNext da API). O Turbopack do
  // Next 16 não resolve isso; por isso dev/build rodam com `--webpack` + `extensionAlias` (docs/open-questions.md).
  webpack(config: { resolve: { extensionAlias?: Record<string, string[]>; alias?: Record<string, string | false> } }) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    // Sem NEXT_PUBLIC_API_MOCKS=1 o código e os dados de mock nem entram no bundle (nem como chunk lazy).
    if (process.env.NEXT_PUBLIC_API_MOCKS !== "1") {
      config.resolve.alias = { ...config.resolve.alias, [MOCK_FETCH_MODULE]: false };
    }
    return config;
  },
  async rewrites() {
    const apiUrl = resolveApiUrl(process.env);
    return apiUrl === null ? [] : apiProxyRewrites(apiUrl);
  },
};

export default nextConfig;
