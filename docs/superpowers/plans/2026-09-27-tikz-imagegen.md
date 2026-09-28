# imagegen(Prompt → TikZ → SVG)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个本地运行的 Next.js 网页应用:输入自然语言 → Claude 流式写出 TikZ → 本机 `latex`/`xelatex` + `dvisvgm` 编译成矢量 SVG → 内联到页面;附自动修复、缓存、双主题、历史、下载。

**Architecture:** 两个 route handler(`/api/generate` SSE 流式产 TikZ;`/api/tikz` 编译成 SVG),纯函数库 `lib/tikz`(组装文档、沙箱进程、错误摘要、SVG 清洗、LRU)与 `lib/llm`(prompt、解析、真实/模拟流),客户端 `lib/client`(SSE 解析、5 分钟渲染缓存、localStorage 历史)+ 一个状态机 hook + 六个组件。无数据库。

**Tech Stack:** Node 24 / npm;Next.js 16.3.6(App Router)、React 19.2.8、TypeScript 5;`@anthropic-ai/sdk` 0.128.0;`zod` 4;`vitest` 5;本机 TeX Live 2025(`latex`、`xelatex`、`dvisvgm 3.4.3`)。

**Spec:** `docs/superpowers/specs/2026-09-27-tikz-imagegen-design.md`

## Global Constraints

- 不建 git 仓库、不提交:用户未要求,harness 规定"只有用户要求时才 commit"。计划里没有 commit 步骤。
- 目录 `/Users/ryl/Documents/imagegen`,无 `src/`,别名 `@/*` → 项目根。
- TeX 文档固定为 `\documentclass[dvisvgm,tikz,border=6pt]{standalone}`;不加 `dvisvgm` 选项图形会全部丢失(已验证)。
- 含 CJK 字符时用 `xelatex -no-pdf` 产 `.xdv`,CJK 字体默认 `Hiragino Sans GB`(`PingFang SC` 在 XeTeX 下找不到)。
- 进程沙箱:`-no-shell-escape`,env `openin_any=p openout_any=p`,临时目录,超时 SIGKILL,并发信号量。
- 服务端返回的 SVG 必须经过 `sanitizeSvg`(`\special{dvisvgm:raw}` 可注入 `<script>`,已验证)。
- 默认模型 `claude-opus-5`,`thinking: {type:"adaptive"}`,`output_config.effort` 默认 `medium`,`max_tokens` 16000,流式;beta `server-side-fallback-2026-07-01` + `fallbacks: "default"` 默认开;`IMAGEGEN_FAST_MODE=1` 时加 `fast-mode-2026-02-01` + `speed:"fast"`。
- 所有面向用户的文案用中文;代码注释用英文。
- 每个任务结束时 `npm run typecheck && npm run test` 必须通过。

## Review Focus

1. **LLM 输出整份文档**(含 `\documentclass`)→ 仍要能编译:`parseTikzSource` 只取 `\begin{document}` 内的内容并提升安全 preamble(Task 2 测试 "full document input")。
2. **代码里 `\usetikzlibrary` 跨行或多处**→ 库全部合并且不重复(Task 2 测试 "multi-line and repeated usetikzlibrary")。
3. **编译错误行号**必须对应用户看到的代码行,而不是临时文档行(Task 3 + Task 6 测试 "reports user line numbers")。
4. **死循环 TikZ**→ 在超时后返回 `compile_timeout`,不挂死服务(Task 6 测试 "kills a runaway latex")。
5. **localStorage 配额溢出**(20 张 SVG)→ 写入失败时丢弃最旧条目重试而不是抛错(Task 10 测试 "drops oldest items when storage throws")。

---

### Task 1: 项目骨架与工具链

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.ts`, `.gitignore`, `.env.example`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`(先放最小内容,Task 12 替换)
- Test: 无(以 `npm run typecheck`、`npm run lint`、`npx vitest run --passWithNoTests` 为验收)

**Interfaces:**
- Produces: `npm run dev|build|typecheck|lint|test|check` 脚本;别名 `@/*`。

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "imagegen",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "npm run typecheck && npm run lint && npm run test"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.128.0",
    "next": "16.3.6",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^24",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.3.6",
    "typescript": "^5",
    "vitest": "^5.0.2"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json / next.config.ts / eslint.config.mjs / vitest.config.ts / .gitignore**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts", "**/*.mts"],
  "exclude": ["node_modules", ".next"]
}
```

`next.config.ts`:
```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

`eslint.config.mjs`:
```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
```

`vitest.config.ts`:
```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

`.gitignore`:
```
node_modules
.next
out
*.tsbuildinfo
next-env.d.ts
.env*.local
.DS_Store
```

- [ ] **Step 3: 写 .env.example**

```
# 必填:Anthropic API key(也可用 `ant auth login` 的本地配置)
ANTHROPIC_API_KEY=

# LLM
IMAGEGEN_MODEL=claude-opus-5
IMAGEGEN_EFFORT=medium          # low | medium | high | xhigh | max
IMAGEGEN_MAX_TOKENS=16000
IMAGEGEN_FAST_MODE=0            # 1 = Opus 5 fast mode(约 2.5x 输出速度,2x 价格)
IMAGEGEN_FALLBACKS=1            # 0 = 关闭 server-side refusal fallback
IMAGEGEN_MOCK_LLM=0             # 1 = 不调用 API,用内置样例流式返回(开发/测试)

# TeX
IMAGEGEN_LATEX_TIMEOUT_MS=20000
IMAGEGEN_DVISVGM_TIMEOUT_MS=10000
IMAGEGEN_MAX_CONCURRENCY=4
IMAGEGEN_CJK_FONT=Hiragino Sans GB
# IMAGEGEN_LATEX_BIN=/Library/TeX/texbin/latex
# IMAGEGEN_XELATEX_BIN=/Library/TeX/texbin/xelatex
# IMAGEGEN_DVISVGM_BIN=/Library/TeX/texbin/dvisvgm
```

- [ ] **Step 4: 最小 app/**

`app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "imagegen · TikZ",
  description: "Prompt → TikZ → SVG",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```

`app/page.tsx`:
```tsx
export default function Page() {
  return <main>imagegen</main>;
}
```

`app/globals.css`:
```css
:root { color-scheme: light dark; }
body { margin: 0; font-family: system-ui, sans-serif; }
```

- [ ] **Step 5: 安装并验证**

Run: `cd /Users/ryl/Documents/imagegen && npm install && npm run typecheck && npm run lint && npx vitest run --passWithNoTests`
Expected: 安装成功;typecheck 无错误;lint 无错误;vitest 报告 "No test files found" 且退出码 0。

---

### Task 2: `lib/tikz/types.ts` + `lib/tikz/document.ts`(解析与组装 TeX 文档)

**Files:**
- Create: `lib/tikz/types.ts`, `lib/tikz/document.ts`
- Test: `tests/tikz/document.test.ts`

**Interfaces:**
- Produces:
  - `type Theme = "light"|"dark"`, `type Engine = "latex"|"xelatex"`, `LatexError {line:number|null; message:string}`, `TikzRequest`, `TikzSuccess`, `TikzErrorBody`, `CompileResult`
  - `DEFAULT_LIBRARIES: readonly string[]`, `ALLOWED_PACKAGES: Set<string>`
  - `findForbiddenCommand(source: string): string | null`
  - `hasCjk(text: string): boolean`
  - `normalizeLibraries(names: Iterable<string>): string[]`(去重、过滤、排序)
  - `parseTikzSource(raw: string): ParsedSource` where `ParsedSource = { body: string; libraries: string[]; preamble: string[]; forbiddenPackage: string | null }`
  - `buildDocument(input: { body; libraries; preamble; theme; engine; cjkFont? }): { tex: string; bodyLineOffset: number }`
  - `DEFAULT_CJK_FONT = "Hiragino Sans GB"`

- [ ] **Step 1: 写失败测试 `tests/tikz/document.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
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
    expect(r.body.startsWith("\\begin{tikzpicture}")).toBe(true);
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
    expect(r.body).toBe("\\begin{tikzpicture}\\node[box]{x};\\end{tikzpicture}");
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
    expect(r.body).toBe("\\begin{tikzpicture}\\end{tikzpicture}");
  });

  it("strips markdown fences defensively", () => {
    const r = parseTikzSource("```tikz\n\\begin{tikzpicture}\\end{tikzpicture}\n```");
    expect(r.body).toBe("\\begin{tikzpicture}\\end{tikzpicture}");
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
    expect(lines[0]).toBe("\\documentclass[dvisvgm,tikz,border=6pt]{standalone}");
    expect(tex).toContain(`\\usetikzlibrary{${normalizeLibraries([...DEFAULT_LIBRARIES, "calc"]).join(",")}}`);
    expect(tex).toContain("\\usepackage{pgfplots}");
    expect(tex).not.toContain("definecolor{black}");
    expect(lines[bodyLineOffset]).toBe(base.body);
    expect(lines[bodyLineOffset - 1]).toBe("\\begin{document}");
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/tikz/document.test.ts`
Expected: FAIL — cannot resolve `@/lib/tikz/document`。

- [ ] **Step 3: 写 `lib/tikz/types.ts`**

```ts
export type Theme = "light" | "dark";
export type Engine = "latex" | "xelatex";

export type TikzErrorStage = "request" | "compile" | "convert" | "response";
export type TikzErrorCode =
  | "invalid_request"
  | "forbidden_command"
  | "forbidden_package"
  | "latex_failed"
  | "compile_timeout"
  | "conversion_failed"
  | "conversion_timeout"
  | "upstream_unavailable";

export interface LatexError {
  /** 1-based line in the user's TikZ code; null when the error is outside it. */
  line: number | null;
  message: string;
}

export interface TikzRequest {
  tikz: string;
  libraries?: string[];
  theme?: Theme;
}

export interface TikzSuccess {
  svg: string;
  /** Natural size in TeX points, from the svg root. */
  width: number;
  height: number;
  engine: Engine;
  ms: { compile: number; convert: number; total: number };
  cached: boolean;
}

export interface TikzErrorBody {
  stage: TikzErrorStage;
  code: TikzErrorCode;
  message: string;
  errors?: LatexError[];
  log?: string;
}

export type CompileResult =
  | { ok: true; value: TikzSuccess }
  | { ok: false; status: number; error: TikzErrorBody };
```

- [ ] **Step 4: 写 `lib/tikz/document.ts`**

```ts
import type { Engine, Theme } from "./types";

export const DEFAULT_LIBRARIES: readonly string[] = [
  "arrows.meta", "calc", "positioning", "shapes.geometric", "shapes.misc", "backgrounds", "fit",
  "decorations.pathmorphing", "decorations.markings", "patterns", "matrix", "chains", "angles",
  "quotes", "intersections", "shadows",
];

export const ALLOWED_PACKAGES: Set<string> = new Set([
  "pgfplots", "tikz-cd", "circuitikz", "amsmath", "amssymb", "mathtools", "bm", "tikz-3dplot",
]);

/** Already loaded by the wrapper (or meaningless inside it); a \usepackage line naming them is dropped. */
const IMPLICIT_PACKAGES = new Set([
  "tikz", "xcolor", "standalone", "pgf", "amsmath", "amssymb", "fontspec", "xeCJK", "inputenc", "fontenc",
]);

export const DEFAULT_CJK_FONT = "Hiragino Sans GB";

const LIBRARY_NAME = /^[a-zA-Z0-9.]+$/;

/** Cheap first filter only; the real isolation is the process sandbox in compile.ts. */
const FORBIDDEN_COMMANDS: RegExp[] = [
  /\\special(?![a-zA-Z])/, /\\write(?![a-zA-Z])/, /\\openout(?![a-zA-Z])/, /\\openin(?![a-zA-Z])/, /\\read(?![a-zA-Z])/, /\\input(?![a-zA-Z])/, /\\include(?![a-zA-Z])/,
  /\\InputIfFileExists(?![a-zA-Z])/, /\\catcode(?![a-zA-Z])/, /\\directlua(?![a-zA-Z])/, /\\ShellEscape(?![a-zA-Z])/,
];

const CJK =
  /[\u2E80-\u2FDF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]|[\u{20000}-\u{2FA1F}]/u;

const HOISTABLE_PREAMBLE =
  /^\\(definecolor|colorlet|tikzset|tikzstyle|newcommand|renewcommand|providecommand|pgfdeclarelayer|pgfsetlayers|pgfplotsset|usepgfplotslibrary|usepgflibrary|newcounter|pgfmathdeclarefunction)\b/;

const DARK_THEME_BLOCK = [
  "\\definecolor{black}{RGB}{232,234,240}",
  "\\definecolor{white}{RGB}{24,24,27}",
  "\\tikzset{every picture/.append style={color=black}}",
];

export function findForbiddenCommand(source: string): string | null {
  for (const re of FORBIDDEN_COMMANDS) {
    const m = re.exec(source);
    if (m) return m[0];
  }
  return null;
}

export function hasCjk(text: string): boolean {
  return CJK.test(text);
}

export function normalizeLibraries(names: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const n = raw.trim();
    if (n && LIBRARY_NAME.test(n)) out.add(n);
  }
  return [...out].sort();
}

export interface ParsedSource {
  body: string;
  libraries: string[];
  preamble: string[];
  forbiddenPackage: string | null;
}

export function parseTikzSource(raw: string): ParsedSource {
  let text = raw.replace(/\r\n?/g, "\n").replace(/^\s*```[a-zA-Z]*\s*$/gm, "");
  const libraries = new Set<string>();
  const preamble: string[] = [];
  let forbiddenPackage: string | null = null;

  text = text.replace(/\\usetikzlibrary\s*\{([^}]*)\}/g, (_m, list: string) => {
    for (const n of list.split(",")) libraries.add(n.trim());
    return "";
  });

  let body = text;
  let preambleText = "";
  const docStart = text.indexOf("\\begin{document}");
  if (docStart >= 0) {
    preambleText = text.slice(0, docStart);
    const afterBegin = docStart + "\\begin{document}".length;
    const docEnd = text.indexOf("\\end{document}", afterBegin);
    body = text.slice(afterBegin, docEnd >= 0 ? docEnd : undefined);
  }

  const kept: string[] = [];
  const handleLine = (line: string, inPreamble: boolean): void => {
    const trimmed = line.trim();
    const pkg = /^\\usepackage(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(trimmed);
    if (pkg) {
      const wanted = pkg[1].split(",").map((s) => s.trim()).filter((n) => n && !IMPLICIT_PACKAGES.has(n));
      for (const n of wanted) if (!ALLOWED_PACKAGES.has(n)) forbiddenPackage ??= n;
      if (wanted.length && wanted.every((n) => ALLOWED_PACKAGES.has(n))) preamble.push(`\\usepackage{${wanted.join(",")}}`);
      return;
    }
    if (inPreamble) {
      if (HOISTABLE_PREAMBLE.test(trimmed)) preamble.push(trimmed);
      return;
    }
    if (/^\\(usepgfplotslibrary|usepgflibrary)\b/.test(trimmed) || /^\\pgfplotsset\s*\{[^{}]*\}\s*$/.test(trimmed)) {
      preamble.push(trimmed);
      return;
    }
    kept.push(line);
  };
  for (const line of preambleText.split("\n")) handleLine(line, true);
  for (const line of body.split("\n")) handleLine(line, false);

  let cleanBody = kept.join("\n").trim();
  const hasEnv = /\\begin\{(tikzpicture|tikzcd|circuitikz)\}/.test(cleanBody) || /^\\tikz\b/.test(cleanBody);
  if (cleanBody && !hasEnv) cleanBody = `\\begin{tikzpicture}\n${cleanBody}\n\\end{tikzpicture}`;

  const hasPkg = (name: string) => preamble.some((p) => new RegExp(`^\\\\usepackage\\{[^}]*\\b${name}\\b`).test(p));
  if (/\\begin\{tikzcd\}/.test(cleanBody) && !hasPkg("tikz-cd")) preamble.unshift("\\usepackage{tikz-cd}");
  if (/\\begin\{circuitikz\}/.test(cleanBody) && !hasPkg("circuitikz")) preamble.unshift("\\usepackage{circuitikz}");
  const usesPgfplots =
    /\\begin\{(axis|semilogxaxis|semilogyaxis|loglogaxis|polaraxis)\}/.test(cleanBody) ||
    preamble.some((p) => /^\\(pgfplotsset|usepgfplotslibrary)\b/.test(p));
  if (usesPgfplots && !hasPkg("pgfplots")) preamble.unshift("\\usepackage{pgfplots}");
  if (hasPkg("pgfplots") && !preamble.some((p) => /^\\pgfplotsset\{[^}]*compat=/.test(p))) preamble.push("\\pgfplotsset{compat=1.18}");

  return { body: cleanBody, libraries: normalizeLibraries(libraries), preamble, forbiddenPackage };
}

export interface BuildInput {
  body: string;
  libraries: string[];
  preamble: string[];
  theme: Theme;
  engine: Engine;
  cjkFont?: string;
}

export interface BuiltDocument {
  tex: string;
  /** Number of lines before the body: body line N is document line N + offset. */
  bodyLineOffset: number;
}

export function buildDocument(input: BuildInput): BuiltDocument {
  const libs = normalizeLibraries([...DEFAULT_LIBRARIES, ...input.libraries]);
  const head: string[] = [
    "\\documentclass[dvisvgm,tikz,border=6pt]{standalone}",
    "\\usepackage{amsmath,amssymb}",
  ];
  if (input.engine === "xelatex") {
    const font = input.cjkFont ?? DEFAULT_CJK_FONT;
    head.push("\\usepackage{fontspec}", "\\usepackage{xeCJK}", `\\setCJKmainfont{${font}}`, `\\setCJKsansfont{${font}}`);
  }
  head.push(`\\usetikzlibrary{${libs.join(",")}}`, ...input.preamble);
  if (input.theme === "dark") head.push(...DARK_THEME_BLOCK);
  head.push("\\begin{document}");
  const tex = [...head, input.body, "\\end{document}", ""].join("\n");
  return { tex, bodyLineOffset: head.length };
}
```

- [ ] **Step 5: 运行测试通过**

Run: `npx vitest run tests/tikz/document.test.ts && npm run typecheck`
Expected: 全部 PASS。

---

### Task 3: `lib/tikz/errors.ts`(LaTeX 日志摘要)

**Files:**
- Create: `lib/tikz/errors.ts`
- Test: `tests/tikz/errors.test.ts`

**Interfaces:**
- Consumes: `LatexError` from `lib/tikz/types`
- Produces: `summarizeLatexLog(log: string, bodyLineOffset: number, max?: number): LatexError[]`, `tailOf(log: string, maxBytes?: number): string`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/tikz/errors.test.ts` → FAIL(模块不存在)。

- [ ] **Step 3: 实现**

```ts
import type { LatexError } from "./types";

const FILE_LINE = /^(?:\.\/)?doc\.tex:(\d+): (.+)$/;
const BANG = /^! (.+)$/;
const TEX_LINE_HINT = /^l\.(\d+) /;
const NOISE = /^(Emergency stop|==> Fatal error)/;

export function summarizeLatexLog(log: string, bodyLineOffset: number, max = 5): LatexError[] {
  const lines = log.replace(/\r\n?/g, "\n").split("\n");
  const out: LatexError[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const fl = FILE_LINE.exec(lines[i]);
    const bang = fl ? null : BANG.exec(lines[i]);
    if (!fl && !bang) continue;
    let message = (fl ? fl[2] : (bang as RegExpExecArray)[1]).trimEnd();
    let docLine: number | null = fl ? Number(fl[1]) : null;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "" && !FILE_LINE.test(lines[j]) && !BANG.test(lines[j])) {
      message += " " + lines[j].trim();
      j++;
    }
    if (docLine === null) {
      for (let k = j; k < Math.min(lines.length, j + 12); k++) {
        const h = TEX_LINE_HINT.exec(lines[k]);
        if (h) { docLine = Number(h[1]); break; }
      }
    }
    message = message.replace(/\s+/g, " ").slice(0, 300);
    if (NOISE.test(message)) continue;
    const line = docLine !== null && docLine > bodyLineOffset ? docLine - bodyLineOffset : null;
    const key = `${line}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, message });
  }
  return out;
}

export function tailOf(log: string, maxBytes = 4096): string {
  return log.length <= maxBytes ? log : log.slice(log.length - maxBytes);
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npx vitest run tests/tikz/errors.test.ts` → PASS。

---

### Task 4: `lib/tikz/sanitize.ts`(SVG 清洗与尺寸)

**Files:**
- Create: `lib/tikz/sanitize.ts`
- Test: `tests/tikz/sanitize.test.ts`

**Interfaces:**
- Produces: `sanitizeSvg(raw: string): { svg: string; width: number; height: number }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "@/lib/tikz/sanitize";

const RAW = `<?xml version='1.0' encoding='UTF-8'?>
<!-- This file was generated by dvisvgm 3.4.3 -->
<svg version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' width='291.312139pt' height='156.294755pt' viewBox='-68.014948 -68.014949 291.312139 156.294755'>
<defs><path id='g0-65' d='M1 1'/></defs>
<g id='page1' onclick="alert(1)" onmouseover='x()'>
<script>alert(1)</script><script src="x.js"/>
<foreignObject><div>hi</div></foreignObject>
<a xlink:href="javascript:alert(2)"><use xlink:href='#g0-65'/></a>
</g>
</svg>
`;

describe("sanitizeSvg", () => {
  it("strips scripts, handlers, foreignObject, javascript: links, xml prolog and comments", () => {
    const { svg } = sanitizeSvg(RAW);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/on(click|mouseover)/i);
    expect(svg).not.toMatch(/foreignObject/i);
    expect(svg).not.toMatch(/javascript:/i);
    expect(svg).toContain("<use xlink:href='#g0-65'/>");
    expect(svg).not.toContain("<?xml");
    expect(svg).not.toContain("<!--");
  });

  it("reads width/height in pt from the root, falling back to viewBox", () => {
    expect(sanitizeSvg(RAW)).toMatchObject({ width: 291.312139, height: 156.294755 });
    const r = sanitizeSvg("<svg viewBox='0 0 10 20'></svg>");
    expect(r).toMatchObject({ width: 10, height: 20 });
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL(模块不存在)。

- [ ] **Step 3: 实现**

```ts
export interface SanitizedSvg {
  svg: string;
  width: number;
  height: number;
}

function readLength(tag: string, attr: string): number {
  const m = new RegExp(`\\s${attr}\\s*=\\s*['"]([0-9.]+)(?:pt)?['"]`).exec(tag);
  return m ? Number(m[1]) : 0;
}

/** dvisvgm output is trusted except for raw specials, which can carry arbitrary markup. */
export function sanitizeSvg(raw: string): SanitizedSvg {
  let svg = raw.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  svg = svg.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/<script\b[^>]*\/>/gi, "");
  svg = svg.replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, "");
  svg = svg.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g, "");
  svg = svg.replace(/\s+(?:xlink:)?href\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, "");
  svg = svg.trim();

  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  let width = readLength(root, "width");
  let height = readLength(root, "height");
  if (!(width > 0) || !(height > 0)) {
    const vb = /viewBox\s*=\s*['"]([^'"]+)['"]/i.exec(root);
    const parts = vb ? vb[1].trim().split(/[\s,]+/).map(Number) : [];
    if (parts.length === 4) { width = parts[2]; height = parts[3]; }
  }
  return { svg, width: width > 0 ? width : 0, height: height > 0 ? height : 0 };
}
```

- [ ] **Step 4: 运行测试通过** → PASS。

---

### Task 5: `lib/tikz/cache.ts` + `lib/tikz/semaphore.ts`

**Files:**
- Create: `lib/tikz/cache.ts`, `lib/tikz/semaphore.ts`
- Test: `tests/tikz/cache.test.ts`

**Interfaces:**
- Produces: `class LruCache<K,V> { constructor(max); get(k); set(k,v); has(k); size; clear() }`;`class Semaphore { constructor(limit); acquire(): Promise<() => void> }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { LruCache } from "@/lib/tikz/cache";
import { Semaphore } from "@/lib/tikz/semaphore";

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const c = new LruCache<string, number>(2);
    c.set("a", 1); c.set("b", 2);
    expect(c.get("a")).toBe(1); // refresh a
    c.set("c", 3);              // evicts b
    expect(c.has("b")).toBe(false);
    expect(c.has("a")).toBe(true);
    expect(c.size).toBe(2);
  });
  it("overwrites without growing", () => {
    const c = new LruCache<string, number>(1);
    c.set("a", 1); c.set("a", 2);
    expect(c.get("a")).toBe(2);
    expect(c.size).toBe(1);
  });
});

describe("Semaphore", () => {
  it("limits concurrency and releases in order", async () => {
    const s = new Semaphore(2);
    let active = 0, peak = 0;
    const job = async () => {
      const release = await s.acquire();
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--; release(); release(); // second call must be a no-op
    };
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL。

- [ ] **Step 3: 实现**

`lib/tikz/cache.ts`:
```ts
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  has(key: K): boolean { return this.map.has(key); }
  get size(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
}
```

`lib/tikz/semaphore.ts`:
```ts
export class Semaphore {
  private readonly waiters: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}
```

- [ ] **Step 4: 运行测试通过** → PASS。

---

### Task 6: `lib/env.ts` + `lib/tikz/run.ts` + `lib/tikz/compile.ts`(真编译)

**Files:**
- Create: `lib/env.ts`, `lib/tikz/run.ts`, `lib/tikz/compile.ts`
- Test: `tests/tikz/compile.test.ts`(真跑 latex;找不到 latex 时整组 skip)

**Interfaces:**
- Consumes: Task 2–5 全部导出
- Produces:
  - `getEnv(e?: NodeJS.ProcessEnv): AppEnv`(字段见代码)
  - `runProcess(bin, args, { cwd, env?, timeoutMs }): Promise<RunResult>`,`class MissingBinaryError { bin }`
  - `compileTikz(req: TikzRequest, opts?: Partial<CompileOptions>): Promise<CompileResult>`,`DEFAULT_COMPILE_OPTIONS`,`clearCompileCache()`,`MAX_TIKZ_LENGTH = 60000`

- [ ] **Step 1: 写失败测试 `tests/tikz/compile.test.ts`**

```ts
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
```

- [ ] **Step 2: 运行确认失败** → FAIL(模块不存在)。

- [ ] **Step 3: 写 `lib/env.ts`**

```ts
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AppEnv {
  model: string;
  effort: Effort;
  fastMode: boolean;
  fallbacks: boolean;
  mockLlm: boolean;
  maxTokens: number;
  latexTimeoutMs: number;
  dvisvgmTimeoutMs: number;
  maxConcurrency: number;
  cjkFont: string;
  latexBin: string;
  xelatexBin: string;
  dvisvgmBin: string;
}

const EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getEnv(e: NodeJS.ProcessEnv = process.env): AppEnv {
  const effort = EFFORTS.has(e.IMAGEGEN_EFFORT ?? "") ? (e.IMAGEGEN_EFFORT as Effort) : "medium";
  return {
    model: e.IMAGEGEN_MODEL || "claude-opus-5",
    effort,
    fastMode: e.IMAGEGEN_FAST_MODE === "1",
    fallbacks: e.IMAGEGEN_FALLBACKS !== "0",
    mockLlm: e.IMAGEGEN_MOCK_LLM === "1",
    maxTokens: int(e.IMAGEGEN_MAX_TOKENS, 16000),
    latexTimeoutMs: int(e.IMAGEGEN_LATEX_TIMEOUT_MS, 20000),
    dvisvgmTimeoutMs: int(e.IMAGEGEN_DVISVGM_TIMEOUT_MS, 10000),
    maxConcurrency: int(e.IMAGEGEN_MAX_CONCURRENCY, 4),
    cjkFont: e.IMAGEGEN_CJK_FONT || "Hiragino Sans GB",
    latexBin: e.IMAGEGEN_LATEX_BIN || "latex",
    xelatexBin: e.IMAGEGEN_XELATEX_BIN || "xelatex",
    dvisvgmBin: e.IMAGEGEN_DVISVGM_BIN || "dvisvgm",
  };
}
```

- [ ] **Step 4: 写 `lib/tikz/run.ts`**

```ts
import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

export class MissingBinaryError extends Error {
  constructor(public readonly bin: string) {
    super(`binary not found: ${bin}`);
    this.name = "MissingBinaryError";
  }
}

const MAX_CAPTURE = 512 * 1024;

export function runProcess(
  bin: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs);
    const append = (cur: string, chunk: Buffer) => (cur.length >= MAX_CAPTURE ? cur : cur + chunk.toString("utf8"));
    child.stdout.on("data", (c: Buffer) => { stdout = append(stdout, c); });
    child.stderr.on("data", (c: Buffer) => { stderr = append(stderr, c); });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err.code === "ENOENT" ? new MissingBinaryError(bin) : err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ms: Date.now() - started });
    });
  });
}
```

- [ ] **Step 5: 写 `lib/tikz/compile.ts`**

```ts
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LruCache } from "./cache";
import { buildDocument, findForbiddenCommand, hasCjk, normalizeLibraries, parseTikzSource } from "./document";
import { summarizeLatexLog, tailOf } from "./errors";
import { MissingBinaryError, runProcess, type RunResult } from "./run";
import { sanitizeSvg } from "./sanitize";
import { Semaphore } from "./semaphore";
import type { CompileResult, Engine, TikzErrorBody, TikzRequest, TikzSuccess } from "./types";

export interface CompileOptions {
  latexBin: string;
  xelatexBin: string;
  dvisvgmBin: string;
  latexTimeoutMs: number;
  dvisvgmTimeoutMs: number;
  maxConcurrency: number;
  cjkFont: string;
}

export const DEFAULT_COMPILE_OPTIONS: CompileOptions = {
  latexBin: "latex",
  xelatexBin: "xelatex",
  dvisvgmBin: "dvisvgm",
  latexTimeoutMs: 20_000,
  dvisvgmTimeoutMs: 10_000,
  maxConcurrency: 4,
  cjkFont: "Hiragino Sans GB",
};

export const MAX_TIKZ_LENGTH = 60_000;

const cache = new LruCache<string, TikzSuccess>(200);
let semaphore: Semaphore | null = null;
let semaphoreLimit = 0;
function getSemaphore(limit: number): Semaphore {
  if (!semaphore || semaphoreLimit !== limit) {
    semaphore = new Semaphore(limit);
    semaphoreLimit = limit;
  }
  return semaphore;
}

const fail = (status: number, error: TikzErrorBody): CompileResult => ({ ok: false, status, error });

export function clearCompileCache(): void {
  cache.clear();
}

export async function compileTikz(req: TikzRequest, partial: Partial<CompileOptions> = {}): Promise<CompileResult> {
  const opts: CompileOptions = { ...DEFAULT_COMPILE_OPTIONS, ...partial };
  const started = Date.now();

  if (typeof req.tikz !== "string" || !req.tikz.trim()) return fail(400, { stage: "request", code: "invalid_request", message: "tikz 不能为空" });
  if (req.tikz.length > MAX_TIKZ_LENGTH) return fail(400, { stage: "request", code: "invalid_request", message: `tikz 超过 ${MAX_TIKZ_LENGTH} 字符` });
  const theme = req.theme === "dark" ? "dark" : "light";
  const forbidden = findForbiddenCommand(req.tikz);
  if (forbidden) return fail(400, { stage: "request", code: "forbidden_command", message: `不允许使用 ${forbidden}` });
  const parsed = parseTikzSource(req.tikz);
  if (parsed.forbiddenPackage) return fail(400, { stage: "request", code: "forbidden_package", message: `不允许加载宏包 ${parsed.forbiddenPackage}` });
  if (!parsed.body) return fail(400, { stage: "request", code: "invalid_request", message: "没有可编译的 TikZ 内容" });

  const libraries = normalizeLibraries([...parsed.libraries, ...(req.libraries ?? [])]);
  const engine: Engine = hasCjk(parsed.body + parsed.preamble.join("\n")) ? "xelatex" : "latex";
  const { tex, bodyLineOffset } = buildDocument({ body: parsed.body, libraries, preamble: parsed.preamble, theme, engine, cjkFont: opts.cjkFont });
  const key = createHash("sha256").update(tex).digest("hex");
  const hit = cache.get(key);
  if (hit) return { ok: true, value: { ...hit, cached: true, ms: { ...hit.ms, total: Date.now() - started } } };

  const release = await getSemaphore(opts.maxConcurrency).acquire();
  const dir = await mkdtemp(path.join(os.tmpdir(), "imagegen-"));
  try {
    await writeFile(path.join(dir, "doc.tex"), tex, "utf8");
    const env: NodeJS.ProcessEnv = { ...process.env, openin_any: "p", openout_any: "p" };
    const texBin = engine === "xelatex" ? opts.xelatexBin : opts.latexBin;
    const texArgs = ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", ...(engine === "xelatex" ? ["-no-pdf"] : []), "doc.tex"];

    let latex: RunResult;
    try {
      latex = await runProcess(texBin, texArgs, { cwd: dir, env, timeoutMs: opts.latexTimeoutMs });
    } catch (e) {
      if (e instanceof MissingBinaryError) return fail(503, { stage: "compile", code: "upstream_unavailable", message: `找不到 ${e.bin},请安装 TeX Live 并确认它在 PATH 里` });
      throw e;
    }
    if (latex.timedOut) return fail(504, { stage: "compile", code: "compile_timeout", message: `LaTeX 编译超过 ${opts.latexTimeoutMs} ms 被终止` });
    const log = await readFile(path.join(dir, "doc.log"), "utf8").catch(() => latex.stdout);
    const dviName = engine === "xelatex" ? "doc.xdv" : "doc.dvi";
    const dviExists = await access(path.join(dir, dviName)).then(() => true, () => false);
    if (latex.code !== 0 || !dviExists) {
      return fail(422, { stage: "compile", code: "latex_failed", message: "LaTeX 编译失败", errors: summarizeLatexLog(log, bodyLineOffset), log: tailOf(log) });
    }

    let conv: RunResult;
    try {
      conv = await runProcess(opts.dvisvgmBin, ["--no-fonts", "--precision=3", "-o", "doc.svg", dviName], { cwd: dir, timeoutMs: opts.dvisvgmTimeoutMs });
    } catch (e) {
      if (e instanceof MissingBinaryError) return fail(503, { stage: "convert", code: "upstream_unavailable", message: `找不到 ${e.bin},请安装 dvisvgm` });
      throw e;
    }
    if (conv.timedOut) return fail(504, { stage: "convert", code: "conversion_timeout", message: `dvisvgm 转换超过 ${opts.dvisvgmTimeoutMs} ms 被终止` });
    const rawSvg = await readFile(path.join(dir, "doc.svg"), "utf8").catch(() => null);
    if (conv.code !== 0 || !rawSvg) return fail(500, { stage: "convert", code: "conversion_failed", message: "dvisvgm 转换失败", log: tailOf(conv.stderr || conv.stdout) });

    const { svg, width, height } = sanitizeSvg(rawSvg);
    const value: TikzSuccess = { svg, width, height, engine, ms: { compile: latex.ms, convert: conv.ms, total: Date.now() - started }, cached: false };
    cache.set(key, value);
    return { ok: true, value };
  } finally {
    release();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
```

- [ ] **Step 6: 运行测试通过**

Run: `npx vitest run tests/tikz/compile.test.ts && npm run typecheck`
Expected: 全部 PASS(约 8–10 s,含 1.5 s 超时用例)。

---

### Task 7: `POST /api/tikz` route handler

**Files:**
- Create: `app/api/tikz/route.ts`
- Test: `tests/api/tikz.test.ts`(直接调用导出的 `POST`,不起服务器)

**Interfaces:**
- Consumes: `compileTikz`, `getEnv`
- Produces: `POST(request: Request): Promise<Response>`;`export const runtime = "nodejs"`, `export const dynamic = "force-dynamic"`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行确认失败** → FAIL。

- [ ] **Step 3: 实现**

```ts
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { compileTikz, MAX_TIKZ_LENGTH } from "@/lib/tikz/compile";
import type { TikzErrorBody } from "@/lib/tikz/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  tikz: z.string().min(1).max(MAX_TIKZ_LENGTH),
  libraries: z.array(z.string().regex(/^[a-zA-Z0-9.]+$/)).max(50).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

const bad = (message: string): Response =>
  Response.json({ error: { stage: "request", code: "invalid_request", message } satisfies TikzErrorBody }, { status: 400 });

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return bad("请求体不是合法 JSON");
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return bad(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));

  const env = getEnv();
  const result = await compileTikz(parsed.data, {
    latexBin: env.latexBin,
    xelatexBin: env.xelatexBin,
    dvisvgmBin: env.dvisvgmBin,
    latexTimeoutMs: env.latexTimeoutMs,
    dvisvgmTimeoutMs: env.dvisvgmTimeoutMs,
    maxConcurrency: env.maxConcurrency,
    cjkFont: env.cjkFont,
  });
  return result.ok ? Response.json(result.value) : Response.json({ error: result.error }, { status: result.status });
}
```

- [ ] **Step 4: 运行测试通过** → PASS;`npm run typecheck` 通过。

---

### Task 8: `lib/llm/types.ts` + `lib/llm/prompt.ts` + `lib/llm/parse.ts`

**Files:**
- Create: `lib/llm/types.ts`, `lib/llm/prompt.ts`, `lib/llm/parse.ts`
- Test: `tests/llm/parse.test.ts`, `tests/llm/prompt.test.ts`

**Interfaces:**
- Produces:
  - `GenerateRequest { prompt; theme?; repair?: { code; libraries; errors: LatexError[] } }`
  - `GenerateEvent`(`status | delta | done | error`,见代码)、`GenerateDone`、`GenerateErrorCode`
  - `formatSse(ev: GenerateEvent): string`
  - `SYSTEM_PROMPT: string`, `buildUserMessage(req: GenerateRequest): string`
  - `parseModelOutput(text: string): { code: string; libraries: string[] }`

- [ ] **Step 1: 写失败测试**

`tests/llm/parse.test.ts`:
```ts
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
```

`tests/llm/prompt.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildUserMessage, SYSTEM_PROMPT } from "@/lib/llm/prompt";
import { formatSse } from "@/lib/llm/types";

describe("prompt", () => {
  it("system prompt pins the output contract", () => {
    expect(SYSTEM_PROMPT).toContain("```tikz");
    expect(SYSTEM_PROMPT).toContain("\\special");
    expect(SYSTEM_PROMPT).toContain("standalone");
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
```

- [ ] **Step 2: 运行确认失败** → FAIL。

- [ ] **Step 3: 写 `lib/llm/types.ts`**

```ts
import type { LatexError, Theme } from "@/lib/tikz/types";

export interface RepairContext {
  code: string;
  libraries: string[];
  errors: LatexError[];
}

export interface GenerateRequest {
  prompt: string;
  theme?: Theme;
  repair?: RepairContext;
}

export type GeneratePhase = "thinking" | "writing";

export type GenerateErrorCode = "refused" | "truncated" | "rate_limited" | "auth" | "upstream" | "parse_failed" | "invalid_request";

export interface GenerateUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

export interface GenerateDone {
  code: string;
  libraries: string[];
  model: string;
  usage: GenerateUsage;
  ms: number;
}

export type GenerateEvent =
  | { event: "status"; data: { phase: GeneratePhase } }
  | { event: "delta"; data: { text: string } }
  | { event: "done"; data: GenerateDone }
  | { event: "error"; data: { code: GenerateErrorCode; message: string } };

export function formatSse(ev: GenerateEvent): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}
```

- [ ] **Step 4: 写 `lib/llm/prompt.ts`**

```ts
import { ALLOWED_PACKAGES, DEFAULT_LIBRARIES } from "@/lib/tikz/document";
import type { GenerateRequest } from "./types";

const STYLE_EXAMPLE = String.raw`\usetikzlibrary{arrows.meta,shapes.geometric,calc}
\begin{tikzpicture}[>=Latex, font=\sffamily\small, line cap=round, line join=round]
  % 1. Cell membrane
  \draw[fill=blue!8, draw=blue!80!black, line width=2.5pt]
    plot[smooth cycle, tension=0.8] coordinates {
      (0,3.2) (2.5,3.0) (4.2,1.8) (4.6,-0.5) (3.5,-2.6) (0.8,-3.2) (-2.0,-3.0) (-4.2,-1.5) (-4.5,1.0) (-2.8,2.8)};
  % 2. Nucleus & nucleolus
  \draw[fill=purple!20, draw=purple!80!black, line width=1.5pt] (0,0.3) circle (1.35cm);
  \draw[fill=purple!80!black, draw=purple!95!black] (0.2,0.45) circle (0.42cm);
  \coordinate (nuc-pt) at (-0.6,0.8);
  % 3. Mitochondrion
  \begin{scope}[shift={(-3.0,-1.2)}, rotate=35]
    \draw[fill=red!25, draw=red!70!black, line width=1.2pt] (0,0) ellipse (0.75cm and 0.38cm);
    \draw[red!80!black, line width=1pt] (-0.55,0.15) to[out=0,in=180] (-0.2,-0.15) to[out=0,in=180] (0.15,0.15) to[out=0,in=180] (0.55,-0.1);
  \end{scope}
  \coordinate (mito-pt) at (-3.0,-1.2);
  % 4. Labels, aligned in a left column with gray leaders
  \node[anchor=east] (lbl-nuc) at (-5.4,0.3) {Nucleus};
  \draw[->, thick, gray!60] (lbl-nuc.east) -- (nuc-pt);
  \node[anchor=east] (lbl-mito) at (-5.4,-1.5) {Mitochondrion};
  \draw[->, thick, gray!60] (lbl-mito.east) -- (mito-pt);
\end{tikzpicture}`;

export const SYSTEM_PROMPT = `You are a TikZ illustrator. You turn a natural-language request into one self-contained TikZ picture that compiles inside \`\\documentclass[dvisvgm,tikz]{standalone}\` (pdfTeX \`latex\` → DVI, or XeTeX when the text contains CJK) and is converted to SVG with dvisvgm.

## Output contract (strict)
- Reply with exactly one fenced code block tagged \`\`\`tikz and nothing else: no prose before or after it.
- Inside the block: optional \`\\usetikzlibrary{...}\` lines first, then a single \`\\begin{tikzpicture} ... \\end{tikzpicture}\` (or \`tikzcd\` / \`circuitikz\` environment when appropriate).
- Never write \`\\documentclass\`, \`\\begin{document}\` or \`\\end{document}\`.
- Packages: only ${[...ALLOWED_PACKAGES].join(", ")} may be requested, each as its own \`\\usepackage{...}\` line at the top of the block. amsmath and amssymb are already loaded; pgfplots/tikz-cd/circuitikz are added automatically when you use their environments.
- Already loaded TikZ libraries: ${DEFAULT_LIBRARIES.join(", ")}. Request any other library explicitly with \`\\usetikzlibrary\`.

## Hard constraints (the environment rejects or breaks on these)
- Never use \\special, \\write, \\input, \\include, \\read, \\catcode, \\directlua, shell escape, external files or images.
- No \`shade\`, \`shading\`, \`opacity\` or transparency: dvisvgm renders them poorly. Use flat fills and color mixes like \`blue!15\`.
- Do not name \`black\` or \`white\` explicitly for ink or paper. Leave default colors alone so the picture adapts to light and dark themes; use \`gray!60\` style mixes for neutral tones.
- Every statement ends with \`;\`, every brace is balanced, every node/coordinate name you reference is defined earlier.
- Math only inside \`$...$\` in node text. Keep the drawing within roughly 12cm × 8cm.
- Labels in the language of the request (Chinese/Japanese/Korean are supported).

## Style (this is what makes it look designed)
- Baseline: \`\\begin{tikzpicture}[>=Latex, font=\\sffamily\\small, line cap=round, line join=round]\`.
- Plan, then draw: define named coordinates/anchors first, draw shapes, then add labels.
- Palette: soft fills (\`blue!12\`, \`purple!20\`, \`teal!15\`) with saturated strokes (\`blue!70!black\`), stroke widths 1–2.5pt.
- Labels short, aligned in columns (anchor=east on the left, anchor=west on the right) with thin gray leader lines.
- Number the visual groups with comments (\`% 1. Membrane\`, \`% 2. Nucleus\`).
- Prefer \`plot[smooth cycle]\` for organic shapes, \`to[out=..,in=..]\` for curves, \`\\foreach\` for repetition, \`positioning\` for layout, \`fit\` for grouping boxes, \`matrix\`/\`chains\` for grids and flows.
- Plots: pgfplots with \`\\pgfplotsset{compat=1.18}\`; commutative diagrams: tikz-cd; circuits: circuitikz.

## Style example
\`\`\`tikz
${STYLE_EXAMPLE}
\`\`\``;

export function buildUserMessage(req: GenerateRequest): string {
  const themeNote =
    req.theme === "dark"
      ? "The picture will be shown on a dark background (default ink is remapped to light automatically; do not hardcode black/white)."
      : "The picture will be shown on a light background.";
  if (!req.repair) return `${themeNote}\n\nDraw: ${req.prompt}`;
  const errs = req.repair.errors.map((e) => `- ${e.line !== null ? `line ${e.line}: ` : ""}${e.message}`).join("\n");
  return [
    themeNote,
    "",
    "The TikZ code below failed to compile. Return the complete corrected code as one ```tikz block, changing as little as possible.",
    "",
    `Original request: ${req.prompt}`,
    "",
    "Code:",
    "```tikz",
    req.repair.code,
    "```",
    "",
    "Compiler errors (line numbers refer to the code above):",
    errs,
  ].join("\n");
}
```

- [ ] **Step 5: 写 `lib/llm/parse.ts`**

```ts
import { parseTikzSource } from "@/lib/tikz/document";

export interface ParsedModelOutput {
  code: string;
  libraries: string[];
}

export function parseModelOutput(text: string): ParsedModelOutput {
  const blocks = [...text.matchAll(/```[a-zA-Z]*[ \t]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  let code: string;
  if (blocks.length) {
    code = blocks.find((b) => b.includes("tikzpicture") || b.includes("tikzcd") || b.includes("circuitikz")) ?? blocks[0];
  } else {
    const open = text.indexOf("```");
    if (open >= 0) {
      const nl = text.indexOf("\n", open);
      code = nl >= 0 ? text.slice(nl + 1) : "";
    } else {
      code = text;
    }
  }
  code = code.replace(/\r\n?/g, "\n").trim();
  return { code, libraries: parseTikzSource(code).libraries };
}
```

- [ ] **Step 6: 运行测试通过**

Run: `npx vitest run tests/llm && npm run typecheck` → PASS。

---

### Task 9: `lib/llm/mock.ts` + `lib/llm/generate.ts` + `POST /api/generate`

**Files:**
- Create: `lib/llm/mock.ts`, `lib/llm/generate.ts`, `app/api/generate/route.ts`, `lib/client/sse.ts`(客户端 SSE 解析器,此处先建,Task 10 复用)
- Test: `tests/llm/mock.test.ts`, `tests/api/generate.test.ts`, `tests/client/sse.test.ts`

**Interfaces:**
- Consumes: Task 8 全部;`getEnv`
- Produces:
  - `streamTikzMock(req: GenerateRequest, signal?: AbortSignal): AsyncGenerator<GenerateEvent>`
  - `streamTikz(req: GenerateRequest, cfg: LlmConfig, signal?: AbortSignal): AsyncGenerator<GenerateEvent>` where `LlmConfig = { model; effort; fastMode; fallbacks; maxTokens }`
  - `readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }>`
  - `POST(request: Request): Promise<Response>`(SSE)

- [ ] **Step 1: 写失败测试**

`tests/client/sse.test.ts`:
```ts
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
```

`tests/llm/mock.test.ts`:
```ts
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
```

`tests/api/generate.test.ts`:
```ts
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
```

- [ ] **Step 2: 运行确认失败** → FAIL。

- [ ] **Step 3: 写 `lib/client/sse.ts`**

```ts
export interface SseMessage {
  event: string;
  data: string;
}

function parseFrame(frame: string): SseMessage | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const msg = parseFrame(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (msg) yield msg;
        sep = buffer.indexOf("\n\n");
      }
      if (done) {
        const tail = parseFrame(buffer);
        if (tail) yield tail;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

- [ ] **Step 4: 写 `lib/llm/mock.ts`**

```ts
import { hasCjk } from "@/lib/tikz/document";
import { parseModelOutput } from "./parse";
import type { GenerateEvent, GenerateRequest } from "./types";

const CELL = String.raw`\usetikzlibrary{arrows.meta,shapes.geometric,calc}
\begin{tikzpicture}[>=Latex, font=\sffamily\small, line cap=round, line join=round]
  % 1. Cell membrane
  \draw[fill=blue!8, draw=blue!80!black, line width=2.5pt]
    plot[smooth cycle, tension=0.8] coordinates {
      (0,3.2) (2.5,3.0) (4.2,1.8) (4.6,-0.5) (3.5,-2.6) (0.8,-3.2) (-2.0,-3.0) (-4.2,-1.5) (-4.5,1.0) (-2.8,2.8)};
  % 2. Nucleus & nucleolus
  \draw[fill=purple!20, draw=purple!80!black, line width=1.5pt] (0,0.3) circle (1.35cm);
  \draw[fill=purple!80!black, draw=purple!95!black] (0.2,0.45) circle (0.42cm);
  \coordinate (nuc-pt) at (-0.6,0.8);
  % 3. Mitochondrion
  \begin{scope}[shift={(-3.0,-1.2)}, rotate=35]
    \draw[fill=red!25, draw=red!70!black, line width=1.2pt] (0,0) ellipse (0.75cm and 0.38cm);
    \draw[red!80!black, line width=1pt] (-0.55,0.15) to[out=0,in=180] (-0.2,-0.15) to[out=0,in=180] (0.15,0.15) to[out=0,in=180] (0.55,-0.1);
  \end{scope}
  \coordinate (mito-pt) at (-3.0,-1.2);
  % 4. Golgi
  \draw[magenta!80!black, line width=2.5pt] (2.4,0.6) to[out=100,in=-100] (2.5,-0.6);
  \draw[magenta!80!black, line width=2.5pt] (2.8,0.7) to[out=100,in=-100] (2.9,-0.7);
  \coordinate (golgi-pt) at (2.9,0);
  % 5. Labels
  \node[anchor=east] (lbl-nuc) at (-5.4,0.3) {Nucleus};
  \draw[->, thick, gray!60] (lbl-nuc.east) -- (nuc-pt);
  \node[anchor=east] (lbl-mito) at (-5.4,-1.5) {Mitochondrion};
  \draw[->, thick, gray!60] (lbl-mito.east) -- (mito-pt);
  \node[anchor=west] (lbl-golgi) at (5.4,-0.2) {Golgi apparatus};
  \draw[->, thick, gray!60] (lbl-golgi.west) -- (golgi-pt);
\end{tikzpicture}`;

const CELL_CJK = String.raw`\usetikzlibrary{arrows.meta}
\begin{tikzpicture}[>=Latex, font=\sffamily\small, line cap=round]
  % 1. 细胞膜
  \draw[fill=blue!8, draw=blue!80!black, line width=2pt] plot[smooth cycle, tension=0.8] coordinates {(0,2.6) (3.2,1.8) (3.6,-1.2) (0.5,-2.8) (-3.4,-1.6) (-3.2,1.6)};
  % 2. 细胞核
  \draw[fill=purple!20, draw=purple!80!black, line width=1.2pt] (0,0) circle (1.1cm);
  \coordinate (nuc) at (-0.5,0.5);
  % 3. 标签
  \node[anchor=east] (l1) at (-4.6,0.5) {细胞核};
  \draw[->, thick, gray!60] (l1.east) -- (nuc);
  \node[anchor=west] (l2) at (4.6,1.2) {细胞膜};
  \draw[->, thick, gray!60] (l2.west) -- (2.9,1.7);
\end{tikzpicture}`;

const BROKEN = String.raw`\usetikzlibrary{arrows.meta}
\begin{tikzpicture}[font=\sffamily]
  \node[drwa, fill=blue!10] (a) {A};
  \node[draw, right=1cm of a] (b) {B};
  \draw[-Latex] (a) -- (b);
\end{tikzpicture}`;

const FIXED = BROKEN.replace("drwa", "draw");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Development stand-in for the Claude call: same event protocol, no network. */
export async function* streamTikzMock(req: GenerateRequest, signal?: AbortSignal): AsyncGenerator<GenerateEvent> {
  const started = Date.now();
  yield { event: "status", data: { phase: "thinking" } };
  await sleep(150);
  yield { event: "status", data: { phase: "writing" } };
  const wantFail = /\bfail\b/i.test(req.prompt);
  const source = wantFail ? (req.repair ? FIXED : BROKEN) : hasCjk(req.prompt) ? CELL_CJK : CELL;
  const text = "```tikz\n" + source + "\n```";
  for (let i = 0; i < text.length; i += 40) {
    if (signal?.aborted) return;
    yield { event: "delta", data: { text: text.slice(i, i + 40) } };
    await sleep(12);
  }
  const parsed = parseModelOutput(text);
  yield {
    event: "done",
    data: { code: parsed.code, libraries: parsed.libraries, model: "mock", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, ms: Date.now() - started },
  };
}
```

- [ ] **Step 5: 写 `lib/llm/generate.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "@/lib/env";
import { parseModelOutput } from "./parse";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
import type { GenerateErrorCode, GenerateEvent, GenerateRequest } from "./types";

export interface LlmConfig {
  model: string;
  effort: Effort;
  fastMode: boolean;
  fallbacks: boolean;
  maxTokens: number;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic(); // resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile
  return client;
}

function mapError(err: unknown): { code: GenerateErrorCode; message: string } {
  if (err instanceof Anthropic.AuthenticationError) return { code: "auth", message: "Anthropic API 认证失败:请在 .env.local 里设置 ANTHROPIC_API_KEY" };
  if (err instanceof Anthropic.RateLimitError) return { code: "rate_limited", message: "触发了速率限制,请稍后重试" };
  if (err instanceof Anthropic.APIUserAbortError) return { code: "upstream", message: "已取消" };
  if (err instanceof Anthropic.APIConnectionError) return { code: "upstream", message: `无法连接 Anthropic API:${err.message}` };
  if (err instanceof Anthropic.APIError) return { code: "upstream", message: `Anthropic API ${err.status ?? ""}: ${err.message}` };
  return { code: "upstream", message: err instanceof Error ? err.message : String(err) };
}

export async function* streamTikz(req: GenerateRequest, cfg: LlmConfig, signal?: AbortSignal): AsyncGenerator<GenerateEvent> {
  const started = Date.now();
  const betas: Anthropic.Beta.AnthropicBeta[] = [];
  if (cfg.fallbacks) betas.push("server-side-fallback-2026-07-01");
  if (cfg.fastMode) betas.push("fast-mode-2026-02-01");

  let text = "";
  let phase: "thinking" | "writing" | null = null;
  try {
    const stream = getClient().beta.messages.stream(
      {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        thinking: { type: "adaptive" },
        output_config: { effort: cfg.effort },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: buildUserMessage(req) }],
        ...(betas.length ? { betas } : {}),
        ...(cfg.fallbacks ? { fallbacks: "default" as const } : {}),
        ...(cfg.fastMode ? { speed: "fast" as const } : {}),
      },
      { signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const t = event.content_block.type;
        if (t === "thinking" && phase !== "thinking") { phase = "thinking"; yield { event: "status", data: { phase } }; }
        if (t === "text" && phase !== "writing") { phase = "writing"; yield { event: "status", data: { phase } }; }
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
        yield { event: "delta", data: { text: event.delta.text } };
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") { yield { event: "error", data: { code: "refused", message: "模型拒绝了这个请求" } }; return; }
    if (final.stop_reason === "max_tokens") { yield { event: "error", data: { code: "truncated", message: "输出超过 max_tokens 被截断,请提高 IMAGEGEN_MAX_TOKENS 或简化描述" } }; return; }
    const parsed = parseModelOutput(text);
    if (!parsed.code) { yield { event: "error", data: { code: "parse_failed", message: "模型没有返回 TikZ 代码" } }; return; }
    yield {
      event: "done",
      data: {
        code: parsed.code,
        libraries: parsed.libraries,
        model: final.model,
        usage: { input_tokens: final.usage.input_tokens, output_tokens: final.usage.output_tokens, cache_read_input_tokens: final.usage.cache_read_input_tokens ?? 0 },
        ms: Date.now() - started,
      },
    };
  } catch (err) {
    if (signal?.aborted) return;
    yield { event: "error", data: mapError(err) };
  }
}
```

- [ ] **Step 6: 写 `app/api/generate/route.ts`**

```ts
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { streamTikz } from "@/lib/llm/generate";
import { streamTikzMock } from "@/lib/llm/mock";
import { formatSse, type GenerateEvent } from "@/lib/llm/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  prompt: z.string().trim().min(1).max(4000),
  theme: z.enum(["light", "dark"]).optional(),
  repair: z
    .object({
      code: z.string().max(60_000),
      libraries: z.array(z.string().regex(/^[a-zA-Z0-9.]+$/)).max(50),
      errors: z.array(z.object({ line: z.number().int().nullable(), message: z.string().max(500) })).max(10),
    })
    .optional(),
});

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: { code: "invalid_request", message: "请求体不是合法 JSON" } }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: { code: "invalid_request", message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") } }, { status: 400 });
  }

  const env = getEnv();
  const source: AsyncGenerator<GenerateEvent> = env.mockLlm
    ? streamTikzMock(parsed.data, request.signal)
    : streamTikz(parsed.data, { model: env.model, effort: env.effort, fastMode: env.fastMode, fallbacks: env.fallbacks, maxTokens: env.maxTokens }, request.signal);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of source) controller.enqueue(encoder.encode(formatSse(ev)));
      } catch (err) {
        controller.enqueue(encoder.encode(formatSse({ event: "error", data: { code: "upstream", message: err instanceof Error ? err.message : String(err) } })));
      } finally {
        controller.close();
      }
    },
    cancel() {
      void source.return(undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 7: 运行测试通过**

Run: `npx vitest run tests/llm tests/api tests/client && npm run typecheck && npm run lint`
Expected: PASS;typecheck 通过(若 SDK 类型对 `output_config`/`fallbacks`/`speed` 报错,以 `node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts` 中的字段名为准修正,不要用 `as any`)。

---

### Task 10: 客户端库:`renderCache.ts`、`history.ts`、`download.ts`、`theme.ts`

**Files:**
- Create: `lib/client/renderCache.ts`, `lib/client/history.ts`, `lib/client/download.ts`, `lib/client/theme.ts`
- Test: `tests/client/renderCache.test.ts`, `tests/client/history.test.ts`

**Interfaces:**
- Produces:
  - `RenderKey { code; libraries; theme }`, `RenderResult = { ok: true; value: TikzSuccess } | { ok: false; status: number; error: TikzErrorBody }`
  - `createRenderCache({ ttlMs?, fetcher?, now? })` → `{ render(key, signal?): Promise<RenderResult>; prewarm(key): void; has(key): boolean; clear(): void }`;`defaultRenderCache`
  - `HistoryItem { id; createdAt; prompt; code; libraries; theme; svg; width; height }`;`loadHistory(storage?)`, `pushHistory(item, storage?)`, `removeHistory(id, storage?)`, `clearHistory(storage?)`, `HISTORY_MAX = 20`
  - `svgToDataUrl(svg)`, `downloadSvg(svg, name)`, `svgToPngBlob(svg, widthPt, heightPt, scale?, background?)`, `downloadPng(...)`, `copyText(text)`
  - `readStoredTheme(): Theme | null`, `systemTheme(): Theme`, `applyTheme(t: Theme): void`, `THEME_KEY`

- [ ] **Step 1: 写失败测试**

`tests/client/renderCache.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { createRenderCache, type RenderKey, type RenderResult } from "@/lib/client/renderCache";

const ok = (tag: string): RenderResult => ({ ok: true, value: { svg: `<svg>${tag}</svg>`, width: 1, height: 1, engine: "latex", ms: { compile: 1, convert: 1, total: 2 }, cached: false } });
const key = (theme: "light" | "dark" = "light"): RenderKey => ({ code: "\\draw;", libraries: ["b", "a"], theme });

describe("createRenderCache", () => {
  it("dedupes identical keys (order-insensitive libraries) and in-flight requests", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return ok("x"); });
    const c = createRenderCache({ fetcher });
    const [a, b] = await Promise.all([c.render(key()), c.render({ ...key(), libraries: ["a", "b"] })]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    await c.render(key());
    expect(calls).toBe(1);
    expect(c.has(key())).toBe(true);
    expect(c.has(key("dark"))).toBe(false);
  });

  it("expires after ttl and caches latex_failed but not timeouts", async () => {
    let now = 0;
    const results: RenderResult[] = [
      { ok: false, status: 504, error: { stage: "compile", code: "compile_timeout", message: "t" } },
      { ok: false, status: 422, error: { stage: "compile", code: "latex_failed", message: "e" } },
      ok("late"),
    ];
    const fetcher = vi.fn(async () => results.shift() as RenderResult);
    const c = createRenderCache({ fetcher, ttlMs: 1000, now: () => now });
    await c.render(key());            // timeout: not cached
    const second = await c.render(key()); // latex_failed: cached
    expect(second.ok).toBe(false);
    await c.render(key());
    expect(fetcher).toHaveBeenCalledTimes(2);
    now = 1001;
    const third = await c.render(key());
    expect(third.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("prewarm fires the fetcher once and swallows errors", async () => {
    const fetcher = vi.fn(async () => { throw new Error("boom"); });
    const c = createRenderCache({ fetcher });
    c.prewarm(key());
    c.prewarm(key());
    await new Promise((r) => setTimeout(r, 5));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
```

`tests/client/history.test.ts`:
```ts
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
```

- [ ] **Step 2: 运行确认失败** → FAIL。

- [ ] **Step 3: 写 `lib/client/renderCache.ts`**

```ts
import type { Theme, TikzErrorBody, TikzSuccess } from "@/lib/tikz/types";

export interface RenderKey {
  code: string;
  libraries: string[];
  theme: Theme;
}

export type RenderResult = { ok: true; value: TikzSuccess } | { ok: false; status: number; error: TikzErrorBody };

export type RenderFetcher = (key: RenderKey, signal?: AbortSignal) => Promise<RenderResult>;

export interface RenderCache {
  render(key: RenderKey, signal?: AbortSignal): Promise<RenderResult>;
  prewarm(key: RenderKey): void;
  has(key: RenderKey): boolean;
  clear(): void;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export const fetchRender: RenderFetcher = async (key, signal) => {
  const res = await fetch("/api/tikz", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tikz: key.code, libraries: key.libraries, theme: key.theme }),
    signal,
  });
  const json = (await res.json().catch(() => null)) as { error?: TikzErrorBody } | TikzSuccess | null;
  if (res.ok && json && "svg" in json) return { ok: true, value: json };
  const error: TikzErrorBody = (json && "error" in json && json.error) || { stage: "response", code: "conversion_failed", message: `HTTP ${res.status}` };
  return { ok: false, status: res.status, error };
};

function keyOf(key: RenderKey): string {
  return JSON.stringify([key.code, [...key.libraries].sort(), key.theme]);
}

/** Same result for the same code+libraries+theme within the TTL; concurrent identical requests share one fetch. */
export function createRenderCache(opts: { ttlMs?: number; fetcher?: RenderFetcher; now?: () => number } = {}): RenderCache {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const fetcher = opts.fetcher ?? fetchRender;
  const now = opts.now ?? (() => Date.now());
  const done = new Map<string, { at: number; result: RenderResult }>();
  const inflight = new Map<string, Promise<RenderResult>>();

  const fresh = (k: string) => {
    const hit = done.get(k);
    if (!hit) return undefined;
    if (now() - hit.at > ttl) { done.delete(k); return undefined; }
    return hit.result;
  };

  const render: RenderCache["render"] = (key, signal) => {
    const k = keyOf(key);
    const hit = fresh(k);
    if (hit) return Promise.resolve(hit);
    const pending = inflight.get(k);
    if (pending) return pending;
    const p = fetcher(key, signal)
      .then((result) => {
        if (result.ok || result.error.code === "latex_failed") done.set(k, { at: now(), result });
        return result;
      })
      .finally(() => { inflight.delete(k); });
    inflight.set(k, p);
    return p;
  };

  return {
    render,
    prewarm: (key) => { if (!fresh(keyOf(key)) && !inflight.has(keyOf(key))) void render(key).catch(() => undefined); },
    has: (key) => fresh(keyOf(key)) !== undefined,
    clear: () => { done.clear(); inflight.clear(); },
  };
}

export const defaultRenderCache: RenderCache = createRenderCache();
```

- [ ] **Step 4: 写 `lib/client/history.ts`**

```ts
import type { Theme } from "@/lib/tikz/types";

export interface HistoryItem {
  id: string;
  createdAt: number;
  prompt: string;
  code: string;
  libraries: string[];
  theme: Theme;
  svg: string;
  width: number;
  height: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const HISTORY_KEY = "imagegen.history.v1";
export const HISTORY_MAX = 20;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadHistory(storage: StorageLike | null = defaultStorage()): HistoryItem[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed.filter((x) => x && typeof x.code === "string" && typeof x.svg === "string") as HistoryItem[]) : [];
  } catch {
    return [];
  }
}

function save(items: HistoryItem[], storage: StorageLike): HistoryItem[] {
  let list = items;
  while (list.length) {
    try {
      storage.setItem(HISTORY_KEY, JSON.stringify(list));
      return list;
    } catch {
      list = list.slice(0, -1); // storage full: drop the oldest and retry
    }
  }
  try { storage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
  return [];
}

export function pushHistory(item: HistoryItem, storage: StorageLike | null = defaultStorage()): HistoryItem[] {
  if (!storage) return [item];
  const rest = loadHistory(storage).filter((x) => !(x.code === item.code && x.theme === item.theme));
  return save([item, ...rest].slice(0, HISTORY_MAX), storage);
}

export function removeHistory(id: string, storage: StorageLike | null = defaultStorage()): HistoryItem[] {
  if (!storage) return [];
  return save(loadHistory(storage).filter((x) => x.id !== id), storage);
}

export function clearHistory(storage: StorageLike | null = defaultStorage()): void {
  try { storage?.removeItem(HISTORY_KEY); } catch { /* ignore */ }
}
```

- [ ] **Step 5: 写 `lib/client/download.ts` 与 `lib/client/theme.ts`**

`lib/client/download.ts`:
```ts
const PX_PER_PT = 96 / 72;

export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadSvg(svg: string, name: string): void {
  downloadBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), `${name}.svg`);
}

export function svgToPngBlob(svg: string, widthPt: number, heightPt: number, scale = 2, background?: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(widthPt * PX_PER_PT * scale));
      canvas.height = Math.max(1, Math.round(heightPt * PX_PER_PT * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("canvas 不可用"));
      if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG 编码失败"))), "image/png");
    };
    img.onerror = () => reject(new Error("SVG 无法解码为图片"));
    img.src = svgToDataUrl(svg);
  });
}

export async function downloadPng(svg: string, widthPt: number, heightPt: number, name: string, background?: string): Promise<void> {
  downloadBlob(await svgToPngBlob(svg, widthPt, heightPt, 2, background), `${name}.png`);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function fileStem(prompt: string): string {
  const stem = prompt.trim().slice(0, 40).replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return stem || "tikz";
}
```

`lib/client/theme.ts`:
```ts
import type { Theme } from "@/lib/tikz/types";

export const THEME_KEY = "imagegen.theme";

export function readStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
}

/** Inline in <head> so the first paint already has the right theme. */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){}})();`;
```

- [ ] **Step 6: 运行测试通过**

Run: `npx vitest run tests/client && npm run typecheck` → PASS。

---

### Task 11: `hooks/useGeneration.ts`(状态机)

**Files:**
- Create: `hooks/useGeneration.ts`
- Test: 无单元测试(依赖 fetch + React;在 Task 13 端到端验证)。`npm run typecheck && npm run lint` 必须通过。

**Interfaces:**
- Consumes: `readSse`, `defaultRenderCache`, `GenerateDone`, `GenerateRequest`, `LatexError`, `TikzErrorBody`, `TikzSuccess`, `HistoryItem`
- Produces:
  - `type Phase = "idle"|"thinking"|"writing"|"compiling"|"repairing"|"done"|"error"`
  - `GenerationState { phase; prompt; code; libraries; svg; width; height; error; model; usage; llmMs; compileMs; totalMs; cached; engine; repaired }`
  - `useGeneration({ theme, onRendered? }) → { state, generate(prompt), recompile(code), setCode(code), cancel(), load(item) }`

- [ ] **Step 1: 实现**

```ts
"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { HistoryItem } from "@/lib/client/history";
import { defaultRenderCache, type RenderResult } from "@/lib/client/renderCache";
import { readSse } from "@/lib/client/sse";
import type { GenerateDone, GenerateErrorCode, GenerateRequest } from "@/lib/llm/types";
import type { LatexError, Theme, TikzErrorBody, TikzSuccess } from "@/lib/tikz/types";

export type Phase = "idle" | "thinking" | "writing" | "compiling" | "repairing" | "done" | "error";

export interface GenerationError {
  title: string;
  detail?: string;
  errors?: LatexError[];
  log?: string;
}

export interface GenerationState {
  phase: Phase;
  prompt: string;
  code: string;
  libraries: string[];
  svg: string | null;
  width: number;
  height: number;
  error: GenerationError | null;
  model: string | null;
  usage: GenerateDone["usage"] | null;
  llmMs: number | null;
  compileMs: number | null;
  totalMs: number | null;
  cached: boolean;
  engine: string | null;
  repaired: boolean;
}

const initial: GenerationState = {
  phase: "idle", prompt: "", code: "", libraries: [], svg: null, width: 0, height: 0, error: null,
  model: null, usage: null, llmMs: null, compileMs: null, totalMs: null, cached: false, engine: null, repaired: false,
};

type Action =
  | { type: "start"; prompt: string }
  | { type: "phase"; phase: Phase }
  | { type: "delta"; text: string }
  | { type: "llmDone"; done: GenerateDone; repaired: boolean }
  | { type: "compileStart"; code: string }
  | { type: "rendered"; value: TikzSuccess; totalMs: number | null }
  | { type: "fail"; error: GenerationError }
  | { type: "setCode"; code: string }
  | { type: "load"; item: HistoryItem }
  | { type: "idle" };

function reducer(s: GenerationState, a: Action): GenerationState {
  switch (a.type) {
    case "start":
      return { ...initial, prompt: a.prompt, phase: "thinking", svg: s.svg, width: s.width, height: s.height };
    case "phase":
      return a.phase === "writing" && s.phase !== "writing" ? { ...s, phase: "writing", code: "" } : { ...s, phase: a.phase };
    case "delta":
      return { ...s, code: s.code + a.text };
    case "llmDone":
      return { ...s, code: a.done.code, libraries: a.done.libraries, model: a.done.model, usage: a.done.usage, llmMs: (s.llmMs ?? 0) + a.done.ms, repaired: a.repaired };
    case "compileStart":
      return { ...s, phase: "compiling", code: a.code, error: null };
    case "rendered":
      return { ...s, phase: "done", svg: a.value.svg, width: a.value.width, height: a.value.height, compileMs: a.value.ms.total, cached: a.value.cached, engine: a.value.engine, totalMs: a.totalMs, error: null };
    case "fail":
      return { ...s, phase: "error", error: a.error };
    case "setCode":
      return { ...s, code: a.code };
    case "load":
      return { ...initial, phase: "done", prompt: a.item.prompt, code: a.item.code, libraries: a.item.libraries, svg: a.item.svg, width: a.item.width, height: a.item.height };
    case "idle":
      return { ...s, phase: s.svg ? "done" : "idle" };
  }
}

const LLM_ERROR_TITLES: Record<GenerateErrorCode, string> = {
  refused: "模型拒绝了请求",
  truncated: "输出被截断",
  rate_limited: "触发速率限制",
  auth: "API 认证失败",
  upstream: "模型服务出错",
  parse_failed: "没有拿到 TikZ 代码",
  invalid_request: "请求不合法",
};

function describeTikzError(e: TikzErrorBody): GenerationError {
  const titles: Record<TikzErrorBody["code"], string> = {
    invalid_request: "请求不合法",
    forbidden_command: "代码包含被禁止的命令",
    forbidden_package: "代码请求了不允许的宏包",
    latex_failed: "LaTeX 编译失败",
    compile_timeout: "LaTeX 编译超时",
    conversion_failed: "SVG 转换失败",
    conversion_timeout: "SVG 转换超时",
    upstream_unavailable: "TeX 工具链不可用",
  };
  return { title: titles[e.code] ?? "编译失败", detail: e.message, errors: e.errors, log: e.log };
}

async function runLlm(req: GenerateRequest, signal: AbortSignal, dispatch: (a: Action) => void): Promise<GenerateDone | null> {
  const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req), signal });
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => null)) as { error?: { code?: GenerateErrorCode; message?: string } } | null;
    dispatch({ type: "fail", error: { title: LLM_ERROR_TITLES[j?.error?.code ?? "upstream"] ?? "生成失败", detail: j?.error?.message ?? `HTTP ${res.status}` } });
    return null;
  }
  for await (const msg of readSse(res.body)) {
    const data = JSON.parse(msg.data) as Record<string, unknown>;
    if (msg.event === "status") dispatch({ type: "phase", phase: data.phase as Phase });
    else if (msg.event === "delta") dispatch({ type: "delta", text: String(data.text) });
    else if (msg.event === "done") return data as unknown as GenerateDone;
    else if (msg.event === "error") {
      dispatch({ type: "fail", error: { title: LLM_ERROR_TITLES[data.code as GenerateErrorCode] ?? "生成失败", detail: String(data.message) } });
      return null;
    }
  }
  dispatch({ type: "fail", error: { title: "生成中断", detail: "服务器提前关闭了连接" } });
  return null;
}

export interface UseGenerationOptions {
  theme: Theme;
  onRendered?: (item: HistoryItem) => void;
}

export function useGeneration({ theme, onRendered }: UseGenerationOptions) {
  const [state, dispatch] = useReducer(reducer, initial);
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  const begin = () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    return ac;
  };

  const compile = useCallback(async (code: string, libraries: string[], signal: AbortSignal): Promise<RenderResult> => {
    dispatch({ type: "compileStart", code });
    return defaultRenderCache.render({ code, libraries, theme: themeRef.current }, signal);
  }, []);

  const finish = useCallback((code: string, libraries: string[], result: RenderResult, totalMs: number | null, prompt: string, record: boolean) => {
    if (!result.ok) { dispatch({ type: "fail", error: describeTikzError(result.error) }); return; }
    dispatch({ type: "rendered", value: result.value, totalMs });
    const other: Theme = themeRef.current === "dark" ? "light" : "dark";
    setTimeout(() => defaultRenderCache.prewarm({ code, libraries, theme: other }), 0);
    if (record) {
      onRenderedRef.current?.({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(), prompt, code, libraries, theme: themeRef.current,
        svg: result.value.svg, width: result.value.width, height: result.value.height,
      });
    }
  }, []);

  const generate = useCallback(async (prompt: string) => {
    const ac = begin();
    const t0 = performance.now();
    dispatch({ type: "start", prompt });
    try {
      const first = await runLlm({ prompt, theme: themeRef.current }, ac.signal, dispatch);
      if (!first) return;
      dispatch({ type: "llmDone", done: first, repaired: false });
      let code = first.code, libraries = first.libraries;
      let result = await compile(code, libraries, ac.signal);
      if (!result.ok && result.error.code === "latex_failed" && result.error.errors?.length) {
        dispatch({ type: "phase", phase: "repairing" });
        const second = await runLlm({ prompt, theme: themeRef.current, repair: { code, libraries, errors: result.error.errors } }, ac.signal, dispatch);
        if (!second) return;
        dispatch({ type: "llmDone", done: second, repaired: true });
        code = second.code; libraries = second.libraries;
        result = await compile(code, libraries, ac.signal);
      }
      finish(code, libraries, result, performance.now() - t0, prompt, true);
    } catch (err) {
      if (ac.signal.aborted) dispatch({ type: "idle" });
      else dispatch({ type: "fail", error: { title: "生成失败", detail: err instanceof Error ? err.message : String(err) } });
    }
  }, [compile, finish]);

  const recompile = useCallback(async (code: string, record = true) => {
    const ac = begin();
    const t0 = performance.now();
    const { libraries, prompt } = stateRef.current;
    try {
      const result = await compile(code, libraries, ac.signal);
      finish(code, libraries, result, performance.now() - t0, prompt, record);
    } catch (err) {
      if (ac.signal.aborted) dispatch({ type: "idle" });
      else dispatch({ type: "fail", error: { title: "编译失败", detail: err instanceof Error ? err.message : String(err) } });
    }
  }, [compile, finish]);

  const cancel = useCallback(() => { abortRef.current?.abort(); dispatch({ type: "idle" }); }, []);
  const setCode = useCallback((code: string) => dispatch({ type: "setCode", code }), []);
  const load = useCallback((item: HistoryItem) => {
    abortRef.current?.abort();
    dispatch({ type: "load", item });
    if (item.theme !== themeRef.current) void recompile(item.code, false);
  }, [recompile]);

  // Re-render the current picture when the theme flips (usually a prewarmed cache hit).
  const firstTheme = useRef(true);
  useEffect(() => {
    if (firstTheme.current) { firstTheme.current = false; return; }
    const s = stateRef.current;
    if (s.phase === "done" && s.code) void recompile(s.code, false);
  }, [theme, recompile]);

  return { state, generate, recompile, setCode, cancel, load };
}
```

- [ ] **Step 2: 验证**

Run: `npm run typecheck && npm run lint` → 通过(lint 若对 `react-hooks/exhaustive-deps` 报警,按提示修,不要禁用规则)。

---

### Task 12: 组件、页面与样式

**Files:**
- Create: `components/App.tsx`, `components/PromptBar.tsx`, `components/StatusBar.tsx`, `components/CodePanel.tsx`, `components/Canvas.tsx`, `components/Toolbar.tsx`, `components/HistoryStrip.tsx`
- Modify: `app/page.tsx`, `app/layout.tsx`, `app/globals.css`(替换 Task 1 的占位)
- Test: 无单元测试;`npm run typecheck && npm run lint && npm run build` 必须通过,Task 13 做端到端。

**Interfaces:**
- Consumes: `useGeneration`, `lib/client/*`
- Produces: `<App />`(client component),页面 `/`

- [ ] **Step 1: `app/layout.tsx` 与 `app/page.tsx`**

`app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { THEME_BOOT_SCRIPT } from "@/lib/client/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "imagegen · TikZ",
  description: "Prompt → TikZ → LaTeX → dvisvgm → SVG",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

`app/page.tsx`:
```tsx
import { App } from "@/components/App";

export default function Page() {
  return <App />;
}
```

- [ ] **Step 2: `app/globals.css`**

```css
:root {
  color-scheme: light;
  --bg: #f4f4f5;
  --panel: #ffffff;
  --border: #e4e4e7;
  --text: #18181b;
  --muted: #71717a;
  --accent: #6d28d9;
  --accent-soft: #ede9fe;
  --accent-contrast: #ffffff;
  --danger: #dc2626;
  --danger-soft: #fee2e2;
  --canvas: #ffffff;
  --code-bg: #fafafa;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.05), 0 8px 24px rgba(0, 0, 0, 0.04);
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #111113;
  --panel: #1c1c20;
  --border: #2c2c32;
  --text: #e8eaf0;
  --muted: #9a9aa5;
  --accent: #a78bfa;
  --accent-soft: #2e2547;
  --accent-contrast: #111113;
  --danger: #f87171;
  --danger-soft: #3b1d1d;
  --canvas: #18181b;
  --code-bg: #151518;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.35);
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Segoe UI", sans-serif;
}
button, textarea, input { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.55; }

.app { display: grid; grid-template-rows: auto 1fr; min-height: 100vh; }
.header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
.header__title { font-weight: 650; letter-spacing: -0.01em; }
.header__sub { color: var(--muted); font-size: 12px; }
.header__spacer { flex: 1; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-family: var(--mono); }

.layout { display: grid; grid-template-columns: minmax(340px, 420px) 1fr; gap: 16px; padding: 16px; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
.column { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); }
.panel__head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--muted); }
.panel__head strong { color: var(--text); font-weight: 600; }
.panel__body { padding: 12px; }

.btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); font-size: 13px; }
.btn:hover:not(:disabled) { border-color: var(--accent); }
.btn--primary { background: var(--accent); color: var(--accent-contrast); border-color: transparent; font-weight: 600; }
.btn--primary:hover:not(:disabled) { filter: brightness(1.08); }
.btn--ghost { border-color: transparent; background: transparent; color: var(--muted); }
.btn--ghost:hover:not(:disabled) { color: var(--text); background: var(--accent-soft); }
.btn--sm { padding: 4px 8px; font-size: 12px; }

.prompt textarea { width: 100%; min-height: 96px; resize: vertical; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--code-bg); outline: none; }
.prompt textarea:focus { border-color: var(--accent); }
.prompt__row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.prompt__hint { color: var(--muted); font-size: 12px; margin-left: auto; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.chip { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--muted); }
.chip:hover { color: var(--text); border-color: var(--accent); }

.status { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--muted); align-items: center; }
.status__step { display: inline-flex; align-items: center; gap: 6px; }
.status__step--active { color: var(--accent); font-weight: 600; }
.status__step--done { color: var(--text); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.dot--pulse { animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
.status__meta { margin-left: auto; font-family: var(--mono); }

.code textarea { width: 100%; min-height: 260px; max-height: 60vh; resize: vertical; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--code-bg); font-family: var(--mono); font-size: 12px; line-height: 1.5; white-space: pre; outline: none; tab-size: 2; }
.code textarea:focus { border-color: var(--accent); }
.code__row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.code__libs { color: var(--muted); font-size: 12px; font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.canvas { position: relative; min-height: 420px; display: flex; align-items: center; justify-content: center; background: var(--canvas); border-radius: 12px; overflow: auto; padding: 24px; }
.canvas svg { max-width: 100%; height: auto; display: block; }
.canvas--fit svg { width: 100%; }
.canvas--busy .canvas__img { opacity: 0.35; filter: blur(0.5px); transition: opacity 0.2s; }
.canvas__overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
.canvas__overlay span { padding: 6px 12px; border-radius: 999px; background: var(--panel); border: 1px solid var(--border); font-size: 12px; box-shadow: var(--shadow); }
.canvas__empty { max-width: 460px; text-align: center; color: var(--muted); }
.canvas__empty h2 { color: var(--text); font-size: 18px; margin: 0 0 6px; }
.canvas__error { max-width: 640px; width: 100%; padding: 14px; border-radius: 10px; background: var(--danger-soft); color: var(--text); }
.canvas__error h3 { margin: 0 0 6px; color: var(--danger); font-size: 14px; }
.canvas__error ul { margin: 8px 0 0; padding-left: 18px; font-family: var(--mono); font-size: 12px; }
.canvas__error details { margin-top: 8px; font-size: 12px; }
.canvas__error pre { max-height: 200px; overflow: auto; font-size: 11px; white-space: pre-wrap; margin: 6px 0 0; }

.toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.toolbar__spacer { flex: 1; }
.toolbar__size { color: var(--muted); font-size: 12px; font-family: var(--mono); }

.history { display: flex; gap: 8px; overflow-x: auto; padding: 4px; }
.history__item { flex: 0 0 auto; width: 132px; border: 1px solid var(--border); border-radius: 8px; background: var(--canvas); padding: 6px; text-align: left; display: flex; flex-direction: column; gap: 4px; }
.history__item:hover { border-color: var(--accent); }
.history__item--active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.history__item img { width: 100%; height: 72px; object-fit: contain; }
.history__item span { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history__empty { color: var(--muted); font-size: 12px; padding: 4px; }
```

- [ ] **Step 3: `components/PromptBar.tsx`**

```tsx
"use client";

import { useState, type KeyboardEvent } from "react";

export const EXAMPLES = [
  "动物细胞结构图,标注细胞核、线粒体、内质网、高尔基体",
  "TCP 三次握手时序图",
  "二叉搜索树依次插入 5, 3, 8, 1, 4 后的结构",
  "y = sin x 与 y = cos x 在 [0, 2π] 上的函数图像",
  "一个简单的 RC 低通滤波电路",
  "机器学习训练流程图:数据 → 预处理 → 模型 → 评估 → 部署",
];

interface Props {
  busy: boolean;
  initial?: string;
  onGenerate: (prompt: string) => void;
  onCancel: () => void;
}

export function PromptBar({ busy, initial = "", onGenerate, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const submit = () => { const p = value.trim(); if (p && !busy) onGenerate(p); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  };
  return (
    <section className="panel prompt">
      <div className="panel__head"><strong>描述你要的图</strong><span>自然语言 → TikZ → SVG</span></div>
      <div className="panel__body">
        <textarea value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} placeholder="例如:动物细胞结构图,标注细胞核、线粒体……" aria-label="提示词" />
        <div className="prompt__row">
          <button className="btn btn--primary" onClick={submit} disabled={busy || !value.trim()}>{busy ? "生成中…" : "生成"}</button>
          {busy && <button className="btn btn--ghost" onClick={onCancel}>取消</button>}
          <span className="prompt__hint">⌘/Ctrl + Enter</span>
        </div>
        <div className="chips">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip" onClick={() => { setValue(ex); if (!busy) onGenerate(ex); }}>{ex.length > 22 ? ex.slice(0, 22) + "…" : ex}</button>
          ))}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: `components/StatusBar.tsx`**

```tsx
"use client";

import type { GenerationState, Phase } from "@/hooks/useGeneration";

const STEPS: Array<{ key: Phase; label: string }> = [
  { key: "thinking", label: "思考" },
  { key: "writing", label: "写 TikZ" },
  { key: "compiling", label: "编译" },
  { key: "done", label: "完成" },
];
const ORDER: Phase[] = ["idle", "thinking", "writing", "repairing", "compiling", "done", "error"];

const fmt = (ms: number | null) => (ms === null ? "" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export function StatusBar({ state }: { state: GenerationState }) {
  const idx = ORDER.indexOf(state.phase);
  const active = (p: Phase) => state.phase === p || (p === "writing" && state.phase === "repairing");
  const done = (p: Phase) => idx > ORDER.indexOf(p) && state.phase !== "error";
  return (
    <div className="panel"><div className="panel__body status">
      {STEPS.map((s) => (
        <span key={s.key} className={`status__step ${active(s.key) ? "status__step--active" : done(s.key) ? "status__step--done" : ""}`}>
          <span className={`dot ${active(s.key) && s.key !== "done" ? "dot--pulse" : ""}`} />
          {s.key === "writing" && state.phase === "repairing" ? "自动修复" : s.label}
          {s.key === "writing" && (state.phase === "writing" || state.phase === "repairing") && ` · ${state.code.length} 字符`}
          {s.key === "writing" && state.llmMs !== null && state.phase !== "writing" && state.phase !== "repairing" && ` ${fmt(state.llmMs)}`}
          {s.key === "compiling" && state.compileMs !== null && ` ${fmt(state.compileMs)}${state.cached ? " · 缓存" : ""}`}
          {s.key === "done" && state.totalMs !== null && ` ${fmt(state.totalMs)}`}
        </span>
      ))}
      {state.phase === "error" && <span className="status__step" style={{ color: "var(--danger)" }}>出错</span>}
      <span className="status__meta">
        {state.model && `${state.model}`}
        {state.usage && ` · ${state.usage.output_tokens} out${state.usage.cache_read_input_tokens ? " · cache hit" : ""}`}
        {state.engine && ` · ${state.engine}`}
        {state.repaired && " · 已修复 1 次"}
      </span>
    </div></div>
  );
}
```

- [ ] **Step 5: `components/CodePanel.tsx`**

```tsx
"use client";

import { useState } from "react";
import { copyText } from "@/lib/client/download";

interface Props {
  code: string;
  libraries: string[];
  busy: boolean;
  streaming: boolean;
  onChange: (code: string) => void;
  onRecompile: (code: string) => void;
}

export function CodePanel({ code, libraries, busy, streaming, onChange, onRecompile }: Props) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel code">
      <div className="panel__head">
        <strong>TikZ 代码</strong>
        <span>{streaming ? "流式生成中…" : "可直接编辑后重新编译"}</span>
        <span style={{ marginLeft: "auto" }}>
          <button className="btn btn--ghost btn--sm" onClick={() => setOpen((o) => !o)}>{open ? "收起" : "展开"}</button>
        </span>
      </div>
      {open && (
        <div className="panel__body">
          <textarea value={code} onChange={(e) => onChange(e.target.value)} spellCheck={false} readOnly={streaming} aria-label="TikZ 代码" placeholder="生成后代码会出现在这里" />
          <div className="code__row">
            <button className="btn" onClick={() => onRecompile(code)} disabled={busy || !code.trim()}>重新编译</button>
            <button className="btn btn--ghost" onClick={async () => { setCopied(await copyText(code)); setTimeout(() => setCopied(false), 1500); }} disabled={!code}>{copied ? "已复制" : "复制"}</button>
            <span className="code__libs" title={libraries.join(", ")}>{libraries.length ? `libraries: ${libraries.join(", ")}` : ""}</span>
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 6: `components/Canvas.tsx`**

```tsx
"use client";

import type { GenerationState } from "@/hooks/useGeneration";

interface Props {
  state: GenerationState;
  fit: boolean;
}

const BUSY = new Set(["thinking", "writing", "repairing", "compiling"]);
const LABEL: Record<string, string> = { thinking: "模型思考中…", writing: "正在写 TikZ…", repairing: "编译出错,自动修复中…", compiling: "LaTeX 编译中…" };

export function Canvas({ state, fit }: Props) {
  const busy = BUSY.has(state.phase);
  return (
    <div className={`canvas ${fit ? "canvas--fit" : ""} ${busy ? "canvas--busy" : ""}`}>
      {state.phase === "error" && state.error ? (
        <div className="canvas__error">
          <h3>{state.error.title}</h3>
          {state.error.detail && <div>{state.error.detail}</div>}
          {state.error.errors?.length ? (
            <ul>{state.error.errors.map((e, i) => <li key={i}>{e.line !== null ? `第 ${e.line} 行:` : ""}{e.message}</li>)}</ul>
          ) : null}
          {state.error.log && <details><summary>完整日志(尾部)</summary><pre>{state.error.log}</pre></details>}
        </div>
      ) : state.svg ? (
        // The svg is produced by our own dvisvgm run and sanitized server-side; only one inline copy lives in the DOM.
        <div className="canvas__img" dangerouslySetInnerHTML={{ __html: state.svg }} />
      ) : (
        <div className="canvas__empty">
          <h2>用一句话生成矢量图</h2>
          <p>Claude 写 TikZ 代码,本机 LaTeX 编译,dvisvgm 输出 SVG。没有图像模型,线条与文字全是矢量。试试左侧的示例。</p>
        </div>
      )}
      {busy && <div className="canvas__overlay"><span>{LABEL[state.phase]}</span></div>}
    </div>
  );
}
```

- [ ] **Step 7: `components/Toolbar.tsx` 与 `components/HistoryStrip.tsx`**

`components/Toolbar.tsx`:
```tsx
"use client";

import { downloadPng, downloadSvg, fileStem } from "@/lib/client/download";
import type { GenerationState } from "@/hooks/useGeneration";
import type { Theme } from "@/lib/tikz/types";

interface Props {
  state: GenerationState;
  theme: Theme;
  fit: boolean;
  onToggleTheme: () => void;
  onToggleFit: () => void;
}

export function Toolbar({ state, theme, fit, onToggleTheme, onToggleFit }: Props) {
  const has = Boolean(state.svg);
  const stem = fileStem(state.prompt);
  const bg = theme === "dark" ? "#18181b" : "#ffffff";
  return (
    <div className="toolbar">
      <button className="btn btn--sm" onClick={() => state.svg && downloadSvg(state.svg, stem)} disabled={!has}>下载 SVG</button>
      <button className="btn btn--sm" onClick={() => state.svg && downloadPng(state.svg, state.width, state.height, stem, bg).catch((e: Error) => alert(e.message))} disabled={!has}>下载 PNG ×2</button>
      <button className="btn btn--sm btn--ghost" onClick={onToggleFit} disabled={!has}>{fit ? "实际大小" : "适应宽度"}</button>
      <span className="toolbar__spacer" />
      {has && <span className="toolbar__size">{Math.round(state.width)}×{Math.round(state.height)} pt</span>}
      <button className="btn btn--sm" onClick={onToggleTheme} aria-label="切换主题">{theme === "dark" ? "☀︎ 浅色" : "☾ 深色"}</button>
    </div>
  );
}
```

`components/HistoryStrip.tsx`:
```tsx
"use client";

import { svgToDataUrl } from "@/lib/client/download";
import type { HistoryItem } from "@/lib/client/history";

interface Props {
  items: HistoryItem[];
  activeCode: string;
  onSelect: (item: HistoryItem) => void;
  onClear: () => void;
}

export function HistoryStrip({ items, activeCode, onSelect, onClear }: Props) {
  return (
    <section className="panel">
      <div className="panel__head">
        <strong>历史</strong><span>保存在浏览器本地,最近 {items.length} 张</span>
        {items.length > 0 && <button className="btn btn--ghost btn--sm" style={{ marginLeft: "auto" }} onClick={onClear}>清空</button>}
      </div>
      <div className="panel__body">
        {items.length === 0 ? <div className="history__empty">还没有生成过图。</div> : (
          <div className="history">
            {items.map((it) => (
              <button key={it.id} className={`history__item ${it.code === activeCode ? "history__item--active" : ""}`} onClick={() => onSelect(it)} title={it.prompt}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={svgToDataUrl(it.svg)} alt={it.prompt} />
                <span>{it.prompt}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 8: `components/App.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { Canvas } from "./Canvas";
import { CodePanel } from "./CodePanel";
import { HistoryStrip } from "./HistoryStrip";
import { PromptBar } from "./PromptBar";
import { StatusBar } from "./StatusBar";
import { Toolbar } from "./Toolbar";
import { useGeneration } from "@/hooks/useGeneration";
import { clearHistory, loadHistory, pushHistory, type HistoryItem } from "@/lib/client/history";
import { applyTheme, readStoredTheme, systemTheme } from "@/lib/client/theme";
import type { Theme } from "@/lib/tikz/types";

const BUSY = new Set(["thinking", "writing", "repairing", "compiling"]);

export function App() {
  const [theme, setTheme] = useState<Theme>("light");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [fit, setFit] = useState(true);

  useEffect(() => {
    setTheme(readStoredTheme() ?? systemTheme());
    setHistory(loadHistory());
  }, []);

  const onRendered = useCallback((item: HistoryItem) => setHistory(pushHistory(item)), []);
  const { state, generate, recompile, setCode, cancel, load } = useGeneration({ theme, onRendered });
  const busy = BUSY.has(state.phase);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

  return (
    <div className="app">
      <header className="header">
        <span className="header__title">imagegen</span>
        <span className="header__sub">prompt → TikZ → LaTeX → dvisvgm → SVG</span>
        <span className="header__spacer" />
        {state.model && <span className="badge">{state.model}</span>}
      </header>
      <main className="layout">
        <div className="column">
          <PromptBar busy={busy} onGenerate={generate} onCancel={cancel} />
          <StatusBar state={state} />
          <CodePanel code={state.code} libraries={state.libraries} busy={busy} streaming={state.phase === "writing" || state.phase === "repairing"} onChange={setCode} onRecompile={(c) => void recompile(c)} />
        </div>
        <div className="column">
          <Toolbar state={state} theme={theme} fit={fit} onToggleTheme={toggleTheme} onToggleFit={() => setFit((f) => !f)} />
          <Canvas state={state} fit={fit} />
          <HistoryStrip items={history} activeCode={state.code} onSelect={load} onClear={() => { clearHistory(); setHistory([]); }} />
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 9: 验证**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: 三者通过;`next build` 输出中 `/`、`/api/tikz`、`/api/generate` 三条路由。

---

### Task 13: README、端到端验证

**Files:**
- Create: `README.md`
- Test: 手动端到端脚本(mock 模式 + 真实编译),本机 Chrome headless 截图

- [ ] **Step 1: 写 README.md**

```markdown
# imagegen — Prompt → TikZ → SVG

输入一句话,Claude 写出 TikZ 代码,本机 LaTeX 编译,dvisvgm 转成矢量 SVG 直接内联到页面。没有图像模型,没有数据库。

## 依赖
- Node ≥ 22(开发用 24)、npm
- TeX Live(需要 `latex`、`xelatex`、`dvisvgm`,以及 tikz / pgfplots / tikz-cd / circuitikz / fontspec / xeCJK)。macOS 装 MacTeX 即可。
- Anthropic API key

## 启动
```bash
cp .env.example .env.local   # 填入 ANTHROPIC_API_KEY
npm install
npm run dev                  # http://localhost:3000
```
没有 key 时可以 `IMAGEGEN_MOCK_LLM=1 npm run dev` 跑通整条链路(用内置样例代替模型)。

## 工作流
1. `POST /api/generate`:SSE 流式返回 Claude 写的 TikZ(`status` / `delta` / `done` / `error`)。
2. `POST /api/tikz`:`{tikz, libraries, theme}` → 组装 `standalone` 文档 → `latex`(含 CJK 时 `xelatex -no-pdf`)→ `dvisvgm --no-fonts` → 清洗后返回 `{svg, width, height, ms}`。
3. 编译失败时把错误摘要回传模型自动修一次;仍失败则展示错误与可编辑代码。
4. 客户端按 `code + libraries + theme` 缓存 5 分钟并预热另一主题;服务端 LRU 缓存 200 条。
5. 历史保存在 localStorage(最近 20 张)。

## 配置
见 `.env.example`。常用:`IMAGEGEN_EFFORT=low` 更快,`IMAGEGEN_FAST_MODE=1` 用 Opus 5 fast mode,`IMAGEGEN_CJK_FONT` 换中文字体(默认 Hiragino Sans GB)。

## 安全边界
本地工具级:`-no-shell-escape`、`openin_any=p`、`openout_any=p`、临时目录、超时 SIGKILL、并发上限、命令/宏包名单、SVG 去脚本。不是多租户沙箱,不要直接暴露到公网。

## 命令
`npm run dev` · `npm run build` · `npm run test` · `npm run typecheck` · `npm run lint` · `npm run check`
```

- [ ] **Step 2: 全量测试**

Run: `npm run check`
Expected: typecheck、lint、全部 vitest 通过。

- [ ] **Step 3: mock 模式端到端(API)**

Run:
```bash
cd /Users/ryl/Documents/imagegen
IMAGEGEN_MOCK_LLM=1 PORT=3111 npm run dev > /tmp/imagegen-dev.log 2>&1 &
sleep 8
curl -sN -X POST localhost:3111/api/generate -H 'Content-Type: application/json' -d '{"prompt":"a cell","theme":"light"}' | head -c 600
curl -s -X POST localhost:3111/api/tikz -H 'Content-Type: application/json' -d '{"tikz":"\\begin{tikzpicture}\\node[draw]{hi};\\end{tikzpicture}","theme":"dark"}' | head -c 300
```
Expected: 第一条输出以 `event: status` 开头并含 `event: delta`;第二条返回 `{"svg":"<svg ...` 且含 `#e8eaf0`。

- [ ] **Step 4: 页面截图**

Run:
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1400,900 --screenshot=/tmp/imagegen-home.png http://localhost:3111/ 2>/dev/null
```
Expected: 截图存在,页面显示标题、提示词框、示例 chips、空态画布。用 Read 工具查看截图确认布局没有溢出。

- [ ] **Step 5: 关闭 dev server**

Run: `kill %1` 或 `pkill -f "next dev"`。
