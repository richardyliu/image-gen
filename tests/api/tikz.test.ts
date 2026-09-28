import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/tikz/route";

const post = (body: unknown, raw = false) =>
  POST(new Request("http://localhost/api/tikz", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? (body as string) : JSON.stringify(body) }));

describe("POST /api/tikz", () => {
  it("400 on invalid json and on schema violations", async () => {
    const a = await post("{not json", true);
    expect(a.status).toBe(400);
    expect((await a.json()).error.code).toBe("invalid_request");
    const b = await post({ tikz: "", theme: "blue" });
    expect(b.status).toBe(400);
    const c = await post({ tikz: "x", libraries: ["../evil"] });
    expect(c.status).toBe(400);
  });

  it("400 forbidden_command without touching TeX", async () => {
    const r = await post({ tikz: "\\special{x}" });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("forbidden_command");
  });
});
