import type { NextConfig } from "next";
import { apiProxyRewrites, resolveApiUrl } from "./src/config/api-proxy";

const nextConfig: NextConfig = {
  // Os packages exportam TypeScript sem build; o web importa valores (constantes) de @erp/contracts.
  transpilePackages: ["@erp/contracts"],
  async rewrites() {
    const apiUrl = resolveApiUrl(process.env);
    return apiUrl === null ? [] : apiProxyRewrites(apiUrl);
  },
};

export default nextConfig;
