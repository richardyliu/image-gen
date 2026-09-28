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
