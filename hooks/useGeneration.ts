"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { initialState, reducer, type Action, type GenerationError, type Phase } from "@/lib/client/generationState";
import type { HistoryItem } from "@/lib/client/history";
import { defaultRenderCache, type RenderResult } from "@/lib/client/renderCache";
import { readSse } from "@/lib/client/sse";
import type { GenerateDone, GenerateErrorCode, GenerateRequest } from "@/lib/llm/types";
import type { Theme, TikzErrorBody } from "@/lib/tikz/types";

export type { GenerationError, GenerationState, Phase } from "@/lib/client/generationState";

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
  const title = titles[e.code] ?? "编译失败";
  return { title, detail: e.message === title ? undefined : e.message, errors: e.errors, log: e.log };
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
  const [state, dispatch] = useReducer(reducer, initialState);
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  const themeRef = useRef(theme);
  const onRenderedRef = useRef(onRendered);
  // Sync after every commit (not during render) so callbacks and later effects read the latest values.
  useEffect(() => {
    stateRef.current = state;
    themeRef.current = theme;
    onRenderedRef.current = onRendered;
  });

  const begin = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    return ac;
  }, []);

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
        dispatch({ type: "repairStart" });
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
  }, [begin, compile, finish]);

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
  }, [begin, compile, finish]);

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
