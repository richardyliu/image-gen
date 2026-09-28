import type { HistoryItem } from "@/lib/client/history";
import type { GenerateDone } from "@/lib/llm/types";
import type { LatexError, TikzSuccess } from "@/lib/tikz/types";

export type Phase = "idle" | "thinking" | "writing" | "compiling" | "done" | "error";

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
  /** True from the moment a repair round starts until the next generate/load. */
  repairing: boolean;
  /** True once a repair round produced the current code. */
  repaired: boolean;
}

export const initialState: GenerationState = {
  phase: "idle", prompt: "", code: "", libraries: [], svg: null, width: 0, height: 0, error: null,
  model: null, usage: null, llmMs: null, compileMs: null, totalMs: null, cached: false, engine: null,
  repairing: false, repaired: false,
};

export type Action =
  | { type: "start"; prompt: string }
  | { type: "phase"; phase: Phase }
  | { type: "delta"; text: string }
  | { type: "llmDone"; done: GenerateDone; repaired: boolean }
  | { type: "repairStart" }
  | { type: "compileStart"; code: string }
  | { type: "rendered"; value: TikzSuccess; totalMs: number | null }
  | { type: "fail"; error: GenerationError }
  | { type: "setCode"; code: string }
  | { type: "load"; item: HistoryItem }
  | { type: "idle" };

export function reducer(s: GenerationState, a: Action): GenerationState {
  switch (a.type) {
    case "start":
      return { ...initialState, prompt: a.prompt, phase: "thinking", svg: s.svg, width: s.width, height: s.height };
    case "phase":
      return a.phase === "writing" && s.phase !== "writing" ? { ...s, phase: "writing", code: "" } : { ...s, phase: a.phase };
    case "delta":
      return { ...s, code: s.code + a.text };
    case "llmDone":
      return { ...s, code: a.done.code, libraries: a.done.libraries, model: a.done.model, usage: a.done.usage, llmMs: (s.llmMs ?? 0) + a.done.ms, repaired: a.repaired };
    case "repairStart":
      return { ...s, repairing: true };
    case "compileStart":
      return { ...s, phase: "compiling", code: a.code, error: null };
    case "rendered":
      return { ...s, phase: "done", svg: a.value.svg, width: a.value.width, height: a.value.height, compileMs: a.value.ms.total, cached: a.value.cached, engine: a.value.engine, totalMs: a.totalMs, error: null };
    case "fail":
      return { ...s, phase: "error", error: a.error };
    case "setCode":
      return { ...s, code: a.code };
    case "load":
      return { ...initialState, phase: "done", prompt: a.item.prompt, code: a.item.code, libraries: a.item.libraries, svg: a.item.svg, width: a.item.width, height: a.item.height };
    case "idle":
      return { ...s, phase: s.svg ? "done" : "idle" };
  }
}
