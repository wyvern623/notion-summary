/**
 * テスト用の最小 fetch モック。
 * URL (文字列 includes 判定) ごとに応答を順番に返すルートを登録できる。
 */
import { vi } from "vitest";

export interface MockResponseSpec {
  status?: number;
  body?: unknown;
}

export interface Route {
  match: (url: string) => boolean;
  responses: MockResponseSpec[];
}

export function makeResponse(spec: MockResponseSpec): Response {
  const status = spec.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => spec.body,
    text: async () => (typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body)),
  } as unknown as Response;
}

/**
 * routes を順に評価し、最初にマッチしたルートの次の応答を返す fetch を作る。
 * 同一ルートに複数応答を積めば、呼び出しごとに 1 つずつ消費する (ページネーション用)。
 */
export function createFetchMock(routes: Route[]): typeof fetch {
  const cursors = new Map<Route, number>();
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const route of routes) {
      if (route.match(url)) {
        const idx = cursors.get(route) ?? 0;
        const spec = route.responses[Math.min(idx, route.responses.length - 1)];
        cursors.set(route, idx + 1);
        return makeResponse(spec);
      }
    }
    throw new Error(`fetchMock: no route for ${url}`);
  }) as unknown as typeof fetch;
}
