import { describe, expect, it } from "vitest";
import { streamTikzMock } from "@/lib/llm/mock";
import type { GenerateEvent } from "@/lib/llm/types";

async function collect(gen: AsyncGenerator<GenerateEvent>) {
  const out: GenerateEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("streamTikzMock", () => {
  it("streams status, deltas and a done event whose deltas concatenate to the code", async () => {
    const ev = await collect(streamTikzMock({ prompt: "a cell" }));
    expect(ev[0]).toEqual({ event: "status", data: { phase: "thinking" } });
    const text = ev.filter((e) => e.event === "delta").map((e) => (e as { data: { text: string } }).data.text).join("");
    const done = ev.at(-1);
    expect(done?.event).toBe("done");
    if (done?.event !== "done") return;
    expect(text).toContain(done.data.code);
    expect(done.data.code).toContain("\\begin{tikzpicture}");
    expect(done.data.libraries.length).toBeGreaterThan(0);
  });
  it("returns broken code when the prompt says fail, and fixed code on repair", async () => {
    const bad = (await collect(streamTikzMock({ prompt: "please fail" }))).at(-1);
    expect(bad?.event === "done" && bad.data.code).toContain("drwa");
    const fixed = (await collect(streamTikzMock({ prompt: "please fail", repair: { code: "x", libraries: [], errors: [] } }))).at(-1);
    expect(fixed?.event === "done" && fixed.data.code).not.toContain("drwa");
  });
  it("uses CJK labels for CJK prompts", async () => {
    const d = (await collect(streamTikzMock({ prompt: "画一个细胞" }))).at(-1);
    expect(d?.event === "done" && /[\u4e00-\u9fff]/.test(d.data.code)).toBe(true);
  });
});
