import { describe, expect, it } from "vitest";
import { clearHistory, HISTORY_MAX, loadHistory, pushHistory, removeHistory, type HistoryItem, type StorageLike } from "@/lib/client/history";

function memStorage(failAfterBytes = Infinity): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { if (v.length > failAfterBytes) throw new Error("QuotaExceededError"); m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}
const item = (i: number, extra: Partial<HistoryItem> = {}): HistoryItem => ({ id: `id${i}`, createdAt: i, prompt: `p${i}`, code: `c${i}`, libraries: [], theme: "light", svg: "<svg/>", width: 1, height: 1, ...extra });

describe("history", () => {
  it("pushes to the front, caps at HISTORY_MAX, dedupes by code+theme", () => {
    const s = memStorage();
    for (let i = 0; i < HISTORY_MAX + 5; i++) pushHistory(item(i), s);
    const h = loadHistory(s);
    expect(h).toHaveLength(HISTORY_MAX);
    expect(h[0].id).toBe(`id${HISTORY_MAX + 4}`);
    pushHistory(item(99, { code: h[3].code }), s);
    const h2 = loadHistory(s);
    expect(h2[0].id).toBe("id99");
    expect(h2.filter((x) => x.code === h[3].code)).toHaveLength(1);
  });
  it("returns [] for missing or corrupt storage", () => {
    const s = memStorage();
    expect(loadHistory(s)).toEqual([]);
    s.setItem("imagegen.history.v1", "{nope");
    expect(loadHistory(s)).toEqual([]);
  });
  it("drops oldest items when storage throws", () => {
    const s = memStorage(400);
    for (let i = 0; i < 10; i++) pushHistory(item(i, { svg: "x".repeat(60) }), s);
    const h = loadHistory(s);
    expect(h.length).toBeGreaterThan(0);
    expect(h.length).toBeLessThan(10);
    expect(h[0].id).toBe("id9");
  });
  it("remove and clear", () => {
    const s = memStorage();
    pushHistory(item(1), s); pushHistory(item(2), s);
    removeHistory("id1", s);
    expect(loadHistory(s).map((x) => x.id)).toEqual(["id2"]);
    clearHistory(s);
    expect(loadHistory(s)).toEqual([]);
  });
});
