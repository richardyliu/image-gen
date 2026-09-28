import { describe, expect, it, vi } from "vitest";
import { createRenderCache, type RenderKey, type RenderResult } from "@/lib/client/renderCache";

const ok = (tag: string): RenderResult => ({ ok: true, value: { svg: `<svg>${tag}</svg>`, width: 1, height: 1, engine: "latex", ms: { compile: 1, convert: 1, total: 2 }, cached: false } });
const key = (theme: "light" | "dark" = "light"): RenderKey => ({ code: "\\draw;", libraries: ["b", "a"], theme });

describe("createRenderCache", () => {
  it("dedupes identical keys (order-insensitive libraries) and in-flight requests", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return ok("x"); });
    const c = createRenderCache({ fetcher });
    const [a, b] = await Promise.all([c.render(key()), c.render({ ...key(), libraries: ["a", "b"] })]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    await c.render(key());
    expect(calls).toBe(1);
    expect(c.has(key())).toBe(true);
    expect(c.has(key("dark"))).toBe(false);
  });

  it("expires after ttl and caches latex_failed but not timeouts", async () => {
    let now = 0;
    const results: RenderResult[] = [
      { ok: false, status: 504, error: { stage: "compile", code: "compile_timeout", message: "t" } },
      { ok: false, status: 422, error: { stage: "compile", code: "latex_failed", message: "e" } },
      ok("late"),
    ];
    const fetcher = vi.fn(async () => results.shift() as RenderResult);
    const c = createRenderCache({ fetcher, ttlMs: 1000, now: () => now });
    await c.render(key());            // timeout: not cached
    const second = await c.render(key()); // latex_failed: cached
    expect(second.ok).toBe(false);
    await c.render(key());
    expect(fetcher).toHaveBeenCalledTimes(2);
    now = 1001;
    const third = await c.render(key());
    expect(third.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("prewarm fires the fetcher once and swallows errors", async () => {
    const fetcher = vi.fn(async () => { throw new Error("boom"); });
    const c = createRenderCache({ fetcher });
    c.prewarm(key());
    c.prewarm(key());
    await new Promise((r) => setTimeout(r, 5));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
