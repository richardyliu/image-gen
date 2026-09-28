import type { Theme, TikzErrorBody, TikzSuccess } from "@/lib/tikz/types";

export interface RenderKey {
  code: string;
  libraries: string[];
  theme: Theme;
}

export type RenderResult = { ok: true; value: TikzSuccess } | { ok: false; status: number; error: TikzErrorBody };

export type RenderFetcher = (key: RenderKey, signal?: AbortSignal) => Promise<RenderResult>;

export interface RenderCache {
  render(key: RenderKey, signal?: AbortSignal): Promise<RenderResult>;
  prewarm(key: RenderKey): void;
  has(key: RenderKey): boolean;
  clear(): void;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export const fetchRender: RenderFetcher = async (key, signal) => {
  const res = await fetch("/api/tikz", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tikz: key.code, libraries: key.libraries, theme: key.theme }),
    signal,
  });
  const json = (await res.json().catch(() => null)) as { error?: TikzErrorBody } | TikzSuccess | null;
  if (res.ok && json && "svg" in json) return { ok: true, value: json };
  const error: TikzErrorBody = (json && "error" in json && json.error) || { stage: "response", code: "conversion_failed", message: `HTTP ${res.status}` };
  return { ok: false, status: res.status, error };
};

function keyOf(key: RenderKey): string {
  return JSON.stringify([key.code, [...key.libraries].sort(), key.theme]);
}

/** Same result for the same code+libraries+theme within the TTL; concurrent identical requests share one fetch. */
export function createRenderCache(opts: { ttlMs?: number; fetcher?: RenderFetcher; now?: () => number } = {}): RenderCache {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const fetcher = opts.fetcher ?? fetchRender;
  const now = opts.now ?? (() => Date.now());
  const done = new Map<string, { at: number; result: RenderResult }>();
  const inflight = new Map<string, Promise<RenderResult>>();

  const fresh = (k: string) => {
    const hit = done.get(k);
    if (!hit) return undefined;
    if (now() - hit.at > ttl) { done.delete(k); return undefined; }
    return hit.result;
  };

  const render: RenderCache["render"] = (key, signal) => {
    const k = keyOf(key);
    const hit = fresh(k);
    if (hit) return Promise.resolve(hit);
    const pending = inflight.get(k);
    if (pending) return pending;
    const p = fetcher(key, signal)
      .then((result) => {
        if (result.ok || result.error.code === "latex_failed") done.set(k, { at: now(), result });
        return result;
      })
      .finally(() => { inflight.delete(k); });
    inflight.set(k, p);
    return p;
  };

  return {
    render,
    prewarm: (key) => { if (!fresh(keyOf(key)) && !inflight.has(keyOf(key))) void render(key).catch(() => undefined); },
    has: (key) => fresh(keyOf(key)) !== undefined,
    clear: () => { done.clear(); inflight.clear(); },
  };
}

export const defaultRenderCache: RenderCache = createRenderCache();
