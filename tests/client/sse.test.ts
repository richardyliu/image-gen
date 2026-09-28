import { describe, expect, it } from "vitest";
import { readSse } from "@/lib/client/sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  });
}

describe("readSse", () => {
  it("parses frames split across arbitrary chunk boundaries", async () => {
    const text = 'event: status\ndata: {"phase":"writing"}\n\nevent: delta\ndata: {"text":"a\\nb"}\n\n: comment\n\ndata: plain\n\n';
    const chunks = [text.slice(0, 7), text.slice(7, 30), text.slice(30, 31), text.slice(31)];
    const out = [];
    for await (const m of readSse(streamOf(chunks))) out.push(m);
    expect(out).toEqual([
      { event: "status", data: '{"phase":"writing"}' },
      { event: "delta", data: '{"text":"a\\nb"}' },
      { event: "message", data: "plain" },
    ]);
  });
  it("flushes a final frame without trailing blank line", async () => {
    const out = [];
    for await (const m of readSse(streamOf(["event: done\ndata: {}"]))) out.push(m);
    expect(out).toEqual([{ event: "done", data: "{}" }]);
  });
});
