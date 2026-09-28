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
