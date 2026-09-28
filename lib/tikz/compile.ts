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
  /** Directory the per-compile temp dirs are created in. */
  tmpRoot: string;
}

export const DEFAULT_COMPILE_OPTIONS: CompileOptions = {
  latexBin: "latex",
  xelatexBin: "xelatex",
  dvisvgmBin: "dvisvgm",
  latexTimeoutMs: 20_000,
  dvisvgmTimeoutMs: 10_000,
  maxConcurrency: 4,
  cjkFont: "Hiragino Sans GB",
  tmpRoot: os.tmpdir(),
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
  let dir: string | null = null;
  try {
    try {
      dir = await mkdtemp(path.join(opts.tmpRoot, "imagegen-"));
    } catch (e) {
      return fail(500, { stage: "compile", code: "upstream_unavailable", message: `无法创建临时目录:${e instanceof Error ? e.message : String(e)}` });
    }
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
      return fail(422, { stage: "compile", code: "latex_failed", message: "LaTeX 编译失败", errors: summarizeLatexLog(log, bodyLineOffset - parsed.lineOffset), log: tailOf(log) });
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
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
