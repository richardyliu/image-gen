import { describe, expect, it } from "vitest";
import {
  AXIS_ARROW_STYLE,
  buildDocument,
  DEFAULT_LIBRARIES,
  findForbiddenCommand,
  hasCjk,
  normalizeLibraries,
  parseTikzSource,
} from "@/lib/tikz/document";

describe("parseTikzSource", () => {
  it("extracts libraries and removes the line from the body", () => {
    const r = parseTikzSource("\\usetikzlibrary{arrows.meta, calc}\n\\begin{tikzpicture}\n\\draw (0,0)--(1,1);\n\\end{tikzpicture}");
    expect(r.libraries).toEqual(["arrows.meta", "calc"]);
    expect(r.body).not.toContain("usetikzlibrary");
    expect(r.body.trimStart().startsWith("\\begin{tikzpicture}")).toBe(true);
  });

  it("handles multi-line and repeated usetikzlibrary", () => {
    const r = parseTikzSource("\\usetikzlibrary{\n  arrows.meta,\n  calc}\n\\usetikzlibrary{calc,fit}\n\\begin{tikzpicture}\\end{tikzpicture}");
    expect(r.libraries).toEqual(["arrows.meta", "calc", "fit"]);
  });

  it("drops invalid library names", () => {
    expect(normalizeLibraries(["calc", "bad name", "../x", ""])).toEqual(["calc"]);
  });

  it("wraps bare commands in a tikzpicture", () => {
    const r = parseTikzSource("\\draw (0,0) -- (1,1);");
    expect(r.body).toBe("\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}");
  });

  it("does not wrap tikzcd or circuitikz environments, and adds their packages", () => {
    const cd = parseTikzSource("\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}");
    expect(cd.body.startsWith("\\begin{tikzcd}")).toBe(true);
    expect(cd.preamble).toContain("\\usepackage{tikz-cd}");
    const ct = parseTikzSource("\\begin{circuitikz} \\draw (0,0) to[R] (2,0); \\end{circuitikz}");
    expect(ct.preamble).toContain("\\usepackage{circuitikz}");
  });

  it("adds pgfplots + compat when an axis is used without \\usepackage", () => {
    const r = parseTikzSource("\\begin{tikzpicture}\\begin{axis}\\addplot {x};\\end{axis}\\end{tikzpicture}");
    expect(r.preamble[0]).toBe("\\usepackage{pgfplots}");
    expect(r.preamble).toContain("\\pgfplotsset{compat=1.18}");
  });

  it("full document input: keeps only the document body and hoists safe preamble", () => {
    const src = [
      "\\documentclass{article}",
      "\\usepackage{tikz}",
      "\\usepackage{pgfplots}",
      "\\usetikzlibrary{calc}",
      "\\definecolor{brand}{RGB}{1,2,3}",
      "\\tikzset{box/.style={draw}}",
      "\\begin{document}",
      "\\begin{tikzpicture}\\node[box]{x};\\end{tikzpicture}",
      "\\end{document}",
    ].join("\n");
    const r = parseTikzSource(src);
    expect(r.body.trim()).toBe("\\begin{tikzpicture}\\node[box]{x};\\end{tikzpicture}");
    expect(r.libraries).toEqual(["calc"]);
    expect(r.preamble).toEqual([
      "\\usepackage{pgfplots}",
      "\\definecolor{brand}{RGB}{1,2,3}",
      "\\tikzset{box/.style={draw}}",
      "\\pgfplotsset{compat=1.18}",
    ]);
    expect(r.forbiddenPackage).toBeNull();
  });

  it("reports a package outside the allowlist", () => {
    const r = parseTikzSource("\\usepackage{evilpkg}\n\\begin{tikzpicture}\\end{tikzpicture}");
    expect(r.forbiddenPackage).toBe("evilpkg");
  });

  it("hoists single-line pgfplotsset and usepgfplotslibrary from the body", () => {
    const r = parseTikzSource("\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}\n\\usepgfplotslibrary{fillbetween}\n\\begin{tikzpicture}\\end{tikzpicture}");
    expect(r.preamble).toEqual(["\\usepackage{pgfplots}", "\\pgfplotsset{compat=1.18}", "\\usepgfplotslibrary{fillbetween}"]);
    expect(r.body.trim()).toBe("\\begin{tikzpicture}\\end{tikzpicture}");
  });

  it("strips markdown fences defensively", () => {
    const r = parseTikzSource("```tikz\n\\begin{tikzpicture}\\end{tikzpicture}\n```");
    expect(r.body.trim()).toBe("\\begin{tikzpicture}\\end{tikzpicture}");
  });
});

describe("findForbiddenCommand", () => {
  it("flags \\special and file IO, ignores lookalikes", () => {
    expect(findForbiddenCommand("\\special{dvisvgm:raw x}")).toBe("\\special");
    expect(findForbiddenCommand("\\input{/etc/passwd}")).toBe("\\input");
    expect(findForbiddenCommand("\\immediate\\write18{ls}")).toBe("\\write");
    expect(findForbiddenCommand("\\readline")).toBeNull();
    expect(findForbiddenCommand("\\includegraphics{x}")).toBeNull();
    expect(findForbiddenCommand("\\draw (0,0) -- (1,1);")).toBeNull();
    expect(findForbiddenCommand("\\csname special\\endcsname{dvisvgm:raw x}")).toBe("\\csname special");
  });
});

describe("hasCjk", () => {
  it("detects CJK and ignores Latin", () => {
    expect(hasCjk("细胞核")).toBe(true);
    expect(hasCjk("日本語")).toBe(true);
    expect(hasCjk("Nucleus é ü")).toBe(false);
  });
});

describe("buildDocument", () => {
  const base = { body: "\\begin{tikzpicture}\\node{x};\\end{tikzpicture}", libraries: ["calc"], preamble: ["\\usepackage{pgfplots}"], engine: "latex" as const };

  it("light theme: standalone dvisvgm class, merged libraries, correct line offset", () => {
    const { tex, bodyLineOffset } = buildDocument({ ...base, theme: "light" });
    const lines = tex.split("\n");
    expect(lines[0]).toBe("\\PassOptionsToPackage{dvipsnames,svgnames}{xcolor}");
    expect(lines[1]).toBe("\\documentclass[dvisvgm,tikz,border=6pt]{standalone}");
    expect(tex).toContain(`\\usetikzlibrary{${normalizeLibraries([...DEFAULT_LIBRARIES, "calc"]).join(",")}}`);
    expect(tex).toContain("\\usepackage{pgfplots}");
    expect(tex).not.toContain("definecolor{black}");
    expect(lines[bodyLineOffset]).toBe(base.body);
    expect(lines[bodyLineOffset - 1]).toBe("\\begin{document}");
  });

  it("preloads the axis arrow style (head starts at the endpoint) ahead of the user preamble", () => {
    const { tex } = buildDocument({ ...base, theme: "light" });
    expect(AXIS_ARROW_STYLE).toBe("\\tikzset{axis arrow/.style={-{>[length=#1]}, shorten >=-#1}, axis arrow/.default=6pt}");
    expect(tex).toContain(AXIS_ARROW_STYLE);
    expect(tex.indexOf(AXIS_ARROW_STYLE)).toBeLessThan(tex.indexOf("\\usepackage{pgfplots}"));
  });

  it("dark theme remaps black/white and sets the default ink", () => {
    const { tex } = buildDocument({ ...base, theme: "dark" });
    expect(tex).toContain("\\definecolor{black}{RGB}{232,234,240}");
    expect(tex).toContain("\\definecolor{white}{RGB}{24,24,27}");
    expect(tex).toContain("\\tikzset{every picture/.append style={color=black}}");
  });

  it("xelatex engine loads fontspec + xeCJK with the given font", () => {
    const { tex } = buildDocument({ ...base, theme: "light", engine: "xelatex", cjkFont: "Heiti SC" });
    expect(tex).toContain("\\usepackage{fontspec}");
    expect(tex).toContain("\\setCJKsansfont{Heiti SC}");
  });
});

describe("parseTikzSource line bookkeeping (error lines must match the code the user sees)", () => {
  it("preserves line positions when removing usetikzlibrary/usepackage lines", () => {
    const r = parseTikzSource("\\usetikzlibrary{calc}\n\\usepackage{pgfplots}\n\\begin{tikzpicture}\n\\draw;\n\\end{tikzpicture}");
    const lines = r.body.split("\n");
    expect(lines[2]).toBe("\\begin{tikzpicture}");
    expect(lines[3]).toBe("\\draw;");
    expect(r.lineOffset).toBe(0);
  });
  it("keeps the line count of a multi-line usetikzlibrary", () => {
    const r = parseTikzSource("\\usetikzlibrary{\n  calc,\n  fit}\n\\begin{tikzpicture}\\end{tikzpicture}");
    expect(r.body.split("\n")[3]).toBe("\\begin{tikzpicture}\\end{tikzpicture}");
  });
  it("reports lineOffset -1 when wrapping and the document-body start line for full documents", () => {
    expect(parseTikzSource("\\draw (0,0) -- (1,1);").lineOffset).toBe(-1);
    const full = "\\documentclass{article}\n\\usepackage{tikz}\n\\begin{document}\n\\begin{tikzpicture}\\node{x};\\end{tikzpicture}\n\\end{document}";
    const r = parseTikzSource(full);
    expect(r.lineOffset).toBe(2);
    expect(r.body.split("\n")[1]).toBe("\\begin{tikzpicture}\\node{x};\\end{tikzpicture}");
  });
  it("hoists multi-line preamble macros whole", () => {
    const full = "\\documentclass{standalone}\n\\tikzset{\n  box/.style={draw},\n  arrow/.style={->}\n}\n\\begin{document}\n\\begin{tikzpicture}\\node[box]{x};\\end{tikzpicture}\n\\end{document}";
    const r = parseTikzSource(full);
    expect(r.preamble.join("\n")).toBe("\\tikzset{\n  box/.style={draw},\n  arrow/.style={->}\n}");
  });
});
