import { createErpApi, type ErpApi } from "./endpoints";
import { createHttpClient, type HttpClient } from "./http-client";

export interface ApiRuntime {
  readonly client: HttpClient;
  readonly api: ErpApi;
  readonly mocked: boolean;
}

let runtime: Promise<ApiRuntime> | null = null;

/** `NEXT_PUBLIC_*` precisa aparecer literal para o Next inlinar; com o flag desligado, o import dos mocks some do bundle. */
async function createFetch(): Promise<{ fetch: typeof fetch; mocked: boolean }> {
  if (process.env.NEXT_PUBLIC_API_MOCKS === "1") {
    const { createMockFetch } = await import("./mocks/mock-fetch");
    const session = process.env.NEXT_PUBLIC_API_MOCK_SESSION === "expired" ? "expired" : "active";
    const profile = process.env.NEXT_PUBLIC_API_MOCK_PROFILE === "owner" ? "owner" : "mixed";
    return { fetch: createMockFetch({ session, profile, latencyMs: 250 }), mocked: true };
  }
  return { fetch: (input, init) => globalThis.fetch(input, init), mocked: false };
}

/** Cliente único da aba (o token vive na memória dele). Só no navegador. */
export function getApiRuntime(): Promise<ApiRuntime> {
  runtime ??= createFetch().then(({ fetch, mocked }) => {
    const client = createHttpClient({ fetch });
    return { client, api: createErpApi(client), mocked };
  });
  return runtime;
}
