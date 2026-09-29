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

/** Arrow whose head starts at the path end and sticks out past it, so the line reaches its last tick and no
 *  tick/label sits inside the head (plain `->` puts the tip at the endpoint). `axis arrow=8pt` sets the head
 *  length; the head shape follows the picture's `>=`. Defined before the user preamble so a pasted document can
 *  override it. */
export const AXIS_ARROW_STYLE_NAME = "axis arrow";
export const AXIS_ARROW_STYLE =
  `\\tikzset{${AXIS_ARROW_STYLE_NAME}/.style={-{>[length=#1]}, shorten >=-#1}, ${AXIS_ARROW_STYLE_NAME}/.default=6pt}`;

const LIBRARY_NAME = /^[a-zA-Z0-9.]+$/;

/** Cheap first filter only; the real isolation is the process sandbox in compile.ts.
 *  A TeX control word ends at the first non-letter, so `\write18` must still match `\write`. */
const FORBIDDEN_WORDS = "special|write|openout|openin|read|input|include|InputIfFileExists|catcode|directlua|ShellEscape";
const FORBIDDEN_COMMANDS: RegExp[] = [
  new RegExp(`\\\\(?:${FORBIDDEN_WORDS})(?![a-zA-Z])`),
  new RegExp(`\\\\csname\\s*(?:${FORBIDDEN_WORDS})(?![a-zA-Z])`),
];

const CJK =
  /[⺀-⿟　-〿぀-ヿ㄀-ㄯ㐀-䶿一-鿿豈-﫿＀-￯]|[\u{20000}-\u{2FA1F}]/u;

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
  /** Add to a 1-based body line to get the line in the source the user sees:
   *  0 normally, -1 when a wrapper line was inserted, N for a full document whose body starts N lines in. */
  lineOffset: number;
}

/** Remove matched text but keep its newlines so line numbers stay aligned with the user's code. */
const blankKeepingNewlines = (m: string): string => m.replace(/[^\n]/g, "");

export function parseTikzSource(raw: string): ParsedSource {
  let text = raw.replace(/\r\n?/g, "\n").replace(/^[ \t]*```[a-zA-Z]*[ \t]*$/gm, "");
  const libraries = new Set<string>();
  const preamble: string[] = [];
  let forbiddenPackage: string | null = null;

  text = text.replace(/\\usetikzlibrary\s*\{([^}]*)\}/g, (m, list: string) => {
    for (const n of list.split(",")) libraries.add(n.trim());
    return blankKeepingNewlines(m);
  });

  let body = text;
  let preambleText = "";
  let lineOffset = 0;
  const docStart = text.indexOf("\\begin{document}");
  if (docStart >= 0) {
    preambleText = text.slice(0, docStart);
    lineOffset = (preambleText.match(/\n/g) ?? []).length;
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
      if (!inPreamble) kept.push("");
      return;
    }
    if (inPreamble) {
      // Everything else from a pasted preamble is hoisted line by line (multi-line macros survive because
      // buildDocument joins the entries with newlines); forbidden commands were rejected before parsing.
      if (trimmed && !trimmed.startsWith("\\documentclass")) preamble.push(line.trimEnd());
      return;
    }
    if (/^\\(usepgfplotslibrary|usepgflibrary)\b/.test(trimmed) || /^\\pgfplotsset\s*\{[^{}]*\}\s*$/.test(trimmed)) {
      preamble.push(trimmed);
      kept.push("");
      return;
    }
    kept.push(line);
  };
  for (const line of preambleText.split("\n")) handleLine(line, true);
  for (const line of body.split("\n")) handleLine(line, false);

  let cleanBody = kept.join("\n").trimEnd();
  const hasEnv = /\\begin\{(tikzpicture|tikzcd|circuitikz)\}/.test(cleanBody) || /^\s*\\tikz\b/.test(cleanBody);
  if (cleanBody.trim() && !hasEnv) {
    cleanBody = `\\begin{tikzpicture}\n${cleanBody}\n\\end{tikzpicture}`;
    lineOffset = -1;
  }

  const hasPkg = (name: string) => preamble.some((p) => new RegExp(`^\\\\usepackage\\{[^}]*\\b${name}\\b`).test(p));
  if (/\\begin\{tikzcd\}/.test(cleanBody) && !hasPkg("tikz-cd")) preamble.unshift("\\usepackage{tikz-cd}");
  if (/\\begin\{circuitikz\}/.test(cleanBody) && !hasPkg("circuitikz")) preamble.unshift("\\usepackage{circuitikz}");
  const usesPgfplots =
    /\\begin\{(axis|semilogxaxis|semilogyaxis|loglogaxis|polaraxis)\}/.test(cleanBody) ||
    preamble.some((p) => /^\\(pgfplotsset|usepgfplotslibrary)\b/.test(p));
  if (usesPgfplots && !hasPkg("pgfplots")) preamble.unshift("\\usepackage{pgfplots}");
  if (hasPkg("pgfplots") && !preamble.some((p) => /compat\s*=/.test(p))) preamble.push("\\pgfplotsset{compat=1.18}");

  return { body: cleanBody.trim() ? cleanBody : "", libraries: normalizeLibraries(libraries), preamble, forbiddenPackage, lineOffset };
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
    "\\PassOptionsToPackage{dvipsnames,svgnames}{xcolor}",
    "\\documentclass[dvisvgm,tikz,border=6pt]{standalone}",
    "\\usepackage{amsmath,amssymb}",
  ];
  if (input.engine === "xelatex") {
    const font = input.cjkFont ?? DEFAULT_CJK_FONT;
    head.push("\\usepackage{fontspec}", "\\usepackage{xeCJK}", `\\setCJKmainfont{${font}}`, `\\setCJKsansfont{${font}}`);
  }
  head.push(`\\usetikzlibrary{${libs.join(",")}}`, AXIS_ARROW_STYLE, ...input.preamble);
  if (input.theme === "dark") head.push(...DARK_THEME_BLOCK);
  head.push("\\begin{document}");
  const tex = [...head, input.body, "\\end{document}", ""].join("\n");
  return { tex, bodyLineOffset: head.length };
}
