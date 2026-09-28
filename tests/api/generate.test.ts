import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/generate/route";
import { readSse } from "@/lib/client/sse";

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

describe("POST /api/generate", () => {
  const prev = process.env.IMAGEGEN_MOCK_LLM;
  afterEach(() => { if (prev === undefined) delete process.env.IMAGEGEN_MOCK_LLM; else process.env.IMAGEGEN_MOCK_LLM = prev; });

  it("400 on schema violation", async () => {
    const r = await post({ prompt: "" });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("invalid_request");
  });

  it("streams SSE from the mock when IMAGEGEN_MOCK_LLM=1", async () => {
    process.env.IMAGEGEN_MOCK_LLM = "1";
    const r = await post({ prompt: "a cell", theme: "light" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const events: string[] = [];
    let done: { code: string } | null = null;
    for await (const m of readSse(r.body as ReadableStream<Uint8Array>)) {
      events.push(m.event);
      if (m.event === "done") done = JSON.parse(m.data);
    }
    expect(events[0]).toBe("status");
    expect(events.at(-1)).toBe("done");
    expect(done?.code).toContain("tikzpicture");
  });
});
