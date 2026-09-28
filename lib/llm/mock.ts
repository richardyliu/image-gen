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
