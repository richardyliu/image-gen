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

export type EnvSource = Record<string, string | undefined>;

export function getEnv(e: EnvSource = process.env): AppEnv {
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
