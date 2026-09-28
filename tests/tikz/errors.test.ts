import { describe, expect, it } from "vitest";
import { summarizeLatexLog, tailOf } from "@/lib/tikz/errors";

const LOG = `
This is pdfTeX, Version 3.141592653-2.6-1.40.27 (TeX Live 2025)
./doc.tex:9: Package pgfkeys Error: I do not know the key '/tikz/drwa' and I am 
going to ignore it. Perhaps you misspelled it.

See the pgfkeys package documentation for explanation.
Type  H <return>  for immediate help.
 ...                                              
                                                  
l.9 \\node[drwa]
               {x};
./doc.tex:9: Package pgfkeys Error: I do not know the key '/tikz/drwa' and I am 
going to ignore it. Perhaps you misspelled it.

! Emergency stop.
<*> doc.tex

! LaTeX Error: File \`nothere.sty' not found.

Type X to quit or <RETURN> to proceed,
l.3 \\usepackage{nothere}
`;

describe("summarizeLatexLog", () => {
  it("maps document lines to user lines, joins wrapped lines, dedupes, skips noise", () => {
    const errs = summarizeLatexLog(LOG, 7);
    expect(errs[0]).toEqual({
      line: 2,
      message: "Package pgfkeys Error: I do not know the key '/tikz/drwa' and I am going to ignore it. Perhaps you misspelled it.",
    });
    expect(errs.some((e) => e.message.startsWith("Emergency stop"))).toBe(false);
    const missing = errs.find((e) => e.message.includes("nothere.sty"));
    expect(missing?.line).toBeNull();
    expect(errs.length).toBe(2);
  });

  it("returns [] on an empty log and respects max", () => {
    expect(summarizeLatexLog("", 3)).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => `./doc.tex:${10 + i}: Error ${i}`).join("\n\n");
    expect(summarizeLatexLog(many, 1, 3)).toHaveLength(3);
  });
});

describe("tailOf", () => {
  it("keeps the last N bytes", () => {
    expect(tailOf("abcdef", 3)).toBe("def");
    expect(tailOf("ab", 3)).toBe("ab");
  });
});
