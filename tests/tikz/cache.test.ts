import { describe, expect, it } from "vitest";
import { LruCache } from "@/lib/tikz/cache";
import { Semaphore } from "@/lib/tikz/semaphore";

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const c = new LruCache<string, number>(2);
    c.set("a", 1); c.set("b", 2);
    expect(c.get("a")).toBe(1); // refresh a
    c.set("c", 3);              // evicts b
    expect(c.has("b")).toBe(false);
    expect(c.has("a")).toBe(true);
    expect(c.size).toBe(2);
  });
  it("overwrites without growing", () => {
    const c = new LruCache<string, number>(1);
    c.set("a", 1); c.set("a", 2);
    expect(c.get("a")).toBe(2);
    expect(c.size).toBe(1);
  });
});

describe("Semaphore", () => {
  it("limits concurrency and releases in order", async () => {
    const s = new Semaphore(2);
    let active = 0, peak = 0;
    const job = async () => {
      const release = await s.acquire();
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--; release(); release(); // second call must be a no-op
    };
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });
});
