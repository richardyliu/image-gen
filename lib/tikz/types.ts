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
