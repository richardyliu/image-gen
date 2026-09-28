import { execSync } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { clearCompileCache, compileTikz } from "@/lib/tikz/compile";
import { getEnv } from "@/lib/env";

function hasBin(bin: string): boolean {
  try { execSync(`command -v ${bin}`, { stdio: "ignore" }); return true; } catch { return false; }
}
const HAVE_TEX = hasBin("latex") && hasBin("dvisvgm");

const SIMPLE = "\\usetikzlibrary{arrows.meta}\n\\begin{tikzpicture}[font=\\sffamily]\n\\node[draw,fill=purple!20] (a) {A};\n\\node[draw,right=1cm of a] (b) {B};\n\\draw[-Latex] (a) -- (b);\n\\end{tikzpicture}";

describe.skipIf(!HAVE_TEX)("compileTikz (real TeX)", () => {
  beforeEach(() => clearCompileCache());

  it("compiles a simple picture to an inline-ready svg", async () => {
    const r = await compileTikz({ tikz: SIMPLE, theme: "light" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.svg.startsWith("<svg")).toBe(true);
    expect(r.value.width).toBeGreaterThan(50);
    expect(r.value.engine).toBe("latex");
    const tags = new Set([...r.value.svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]));
    expect([...tags].every((t) => ["svg", "defs", "path", "use", "g"].includes(t))).toBe(true);
    expect(r.value.cached).toBe(false);
    expect(r.value.ms.total).toBeLessThan(10_000);
  });

  it("serves the second identical request from cache", async () => {
    await compileTikz({ tikz: SIMPLE });
    const r = await compileTikz({ tikz: SIMPLE });
    expect(r.ok && r.value.cached).toBe(true);
  });

  it("reports user line numbers on latex errors", async () => {
    const bad = "\\begin{tikzpicture}\n\\node[drwa] {x};\n\\end{tikzpicture}";
    const r = await compileTikz({ tikz: bad });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.error.code).toBe("latex_failed");
    expect(r.error.errors?.[0].line).toBe(2);
    expect(r.error.errors?.[0].message).toContain("drwa");
    expect(r.error.log?.length).toBeGreaterThan(0);
  });

  it("rejects forbidden commands and packages before spawning", async () => {
    const a = await compileTikz({ tikz: "\\begin{tikzpicture}\\special{dvisvgm:raw <script/>}\\end{tikzpicture}" });
    expect(!a.ok && a.error.code).toBe("forbidden_command");
    const b = await compileTikz({ tikz: "\\usepackage{shellesc}\n\\begin{tikzpicture}\\end{tikzpicture}" });
    expect(!b.ok && b.error.code).toBe("forbidden_package");
    const c = await compileTikz({ tikz: "   " });
    expect(!c.ok && c.error.code).toBe("invalid_request");
  });

  it("dark theme remaps the default ink", async () => {
    const r = await compileTikz({ tikz: SIMPLE, theme: "dark" });
    expect(r.ok && r.value.svg).toContain("#e8eaf0");
  });

  it.skipIf(!hasBin("xelatex"))("uses xelatex for CJK text", async () => {
    const r = await compileTikz({ tikz: "\\begin{tikzpicture}\\node[draw]{细胞核};\\end{tikzpicture}", theme: "light" }, { cjkFont: getEnv().cjkFont });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.engine).toBe("xelatex");
    expect(r.value.svg).toContain("<path");
  });

  it("kills a runaway latex and reports compile_timeout", async () => {
    const loop = "\\begin{tikzpicture}\\newcount\\cnt \\loop \\advance\\cnt by 1 \\ifnum\\cnt>0 \\repeat\\end{tikzpicture}";
    const r = await compileTikz({ tikz: loop }, { latexTimeoutMs: 1500 });
    expect(!r.ok && r.error.code).toBe("compile_timeout");
    expect(!r.ok && r.status).toBe(504);
  });

  it("maps error lines to the code the user sees, including a leading usetikzlibrary line", async () => {
    const broken = "\\usetikzlibrary{arrows.meta}\n\\begin{tikzpicture}[font=\\sffamily]\n  \\node[drwa, fill=blue!10] (a) {A};\n\\end{tikzpicture}";
    const r = await compileTikz({ tikz: broken });
    expect(!r.ok && r.error.errors?.[0].line).toBe(3);
  });

  it("compiles a pasted full document with a multi-line preamble macro", async () => {
    const full = "\\documentclass{standalone}\n\\usepackage{tikz}\n\\tikzset{\n  box/.style={draw, fill=blue!10}\n}\n\\begin{document}\n\\begin{tikzpicture}\\node[box]{x};\\end{tikzpicture}\n\\end{document}";
    const r = await compileTikz({ tikz: full });
    expect(r.ok).toBe(true);
  });

  it("accepts dvipsnames/svgnames colors without a repair round", async () => {
    const r = await compileTikz({ tikz: "\\begin{tikzpicture}\\node[fill=RoyalBlue!20, draw=NavyBlue, text=ForestGreen]{x};\\end{tikzpicture}" });
    expect(r.ok).toBe(true);
  });

  it("does not leak a semaphore slot when the temp dir cannot be created", async () => {
    const opts = { maxConcurrency: 1, tmpRoot: "/definitely/not/a/dir" };
    const a = await compileTikz({ tikz: SIMPLE + "%1" }, opts);
    expect(a.ok).toBe(false);
    const b = await compileTikz({ tikz: SIMPLE + "%2" }, opts);
    expect(b.ok).toBe(false);
    const c = await Promise.race([compileTikz({ tikz: SIMPLE + "%3" }, { maxConcurrency: 1 }), new Promise<string>((res) => setTimeout(() => res("hung"), 4000))]);
    expect(c).not.toBe("hung");
  });

  it("reports upstream_unavailable when the binary is missing", async () => {
    const r = await compileTikz({ tikz: SIMPLE }, { latexBin: "definitely-not-a-binary-xyz" });
    expect(!r.ok && r.error.code).toBe("upstream_unavailable");
    expect(!r.ok && r.status).toBe(503);
  });
});

describe("getEnv", () => {
  it("applies defaults and parses overrides", () => {
    const e = getEnv({});
    expect(e).toMatchObject({ model: "claude-opus-5", effort: "medium", fastMode: false, fallbacks: true, mockLlm: false, maxTokens: 16000, latexTimeoutMs: 20000, maxConcurrency: 4 });
    const o = getEnv({ IMAGEGEN_EFFORT: "low", IMAGEGEN_FAST_MODE: "1", IMAGEGEN_FALLBACKS: "0", IMAGEGEN_LATEX_TIMEOUT_MS: "5000", IMAGEGEN_MODEL: "claude-sonnet-5" });
    expect(o).toMatchObject({ effort: "low", fastMode: true, fallbacks: false, latexTimeoutMs: 5000, model: "claude-sonnet-5" });
    expect(getEnv({ IMAGEGEN_EFFORT: "bogus" }).effort).toBe("medium");
  });
});
