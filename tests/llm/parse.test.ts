import { describe, expect, it } from "vitest";
import { parseModelOutput } from "@/lib/llm/parse";

const PIC = "\\usetikzlibrary{calc}\n\\begin{tikzpicture}\n\\draw (0,0)--(1,1);\n\\end{tikzpicture}";

describe("parseModelOutput", () => {
  it("takes the fenced tikz block and reports its libraries", () => {
    const r = parseModelOutput("Here you go:\n```tikz\n" + PIC + "\n```\nDone.");
    expect(r.code).toBe(PIC);
    expect(r.libraries).toEqual(["calc"]);
  });
  it("accepts untagged fences and no fences", () => {
    expect(parseModelOutput("```\n" + PIC + "\n```").code).toBe(PIC);
    expect(parseModelOutput(PIC).code).toBe(PIC);
  });
  it("prefers the block containing tikzpicture when several exist", () => {
    const r = parseModelOutput("```text\nnotes\n```\n```latex\n" + PIC + "\n```");
    expect(r.code).toBe(PIC);
  });
  it("recovers a truncated block with no closing fence", () => {
    const r = parseModelOutput("```tikz\n\\begin{tikzpicture}\n\\draw (0,0)");
    expect(r.code).toBe("\\begin{tikzpicture}\n\\draw (0,0)");
  });
  it("returns empty code for empty output", () => {
    expect(parseModelOutput("   ").code).toBe("");
  });
});
