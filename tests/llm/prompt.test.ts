import { describe, expect, it } from "vitest";
import { buildUserMessage, SYSTEM_PROMPT } from "@/lib/llm/prompt";
import { AXIS_ARROW_STYLE_NAME } from "@/lib/tikz/document";
import { formatSse } from "@/lib/llm/types";

describe("prompt", () => {
  it("system prompt pins the output contract", () => {
    expect(SYSTEM_PROMPT).toContain("```tikz");
    expect(SYSTEM_PROMPT).toContain("\\special");
    expect(SYSTEM_PROMPT).toContain("standalone");
  });
  it("system prompt tells the model to draw axes with the preloaded axis arrow style", () => {
    expect(SYSTEM_PROMPT).toContain(`\\draw[${AXIS_ARROW_STYLE_NAME}, thick] (0,0) -- (0,10);`);
  });
  it("user message carries theme and prompt; repair carries code and errors", () => {
    expect(buildUserMessage({ prompt: "a cell", theme: "dark" })).toMatch(/dark background[\s\S]*Draw: a cell/);
    const m = buildUserMessage({ prompt: "a cell", repair: { code: "\\draw;", libraries: [], errors: [{ line: 3, message: "boom" }, { line: null, message: "meh" }] } });
    expect(m).toContain("```tikz\n\\draw;\n```");
    expect(m).toContain("- line 3: boom");
    expect(m).toContain("- meh");
  });
  it("formatSse emits event/data frames", () => {
    expect(formatSse({ event: "delta", data: { text: "x\ny" } })).toBe('event: delta\ndata: {"text":"x\\ny"}\n\n');
  });
});
