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
