"use client";

import type { GenerationState } from "@/hooks/useGeneration";

interface Props {
  state: GenerationState;
  fit: boolean;
}

const BUSY = new Set(["thinking", "writing", "compiling"]);
const LABEL: Record<string, string> = { thinking: "模型思考中…", writing: "正在写 TikZ…", compiling: "LaTeX 编译中…" };

export function Canvas({ state, fit }: Props) {
  const busy = BUSY.has(state.phase);
  const label = state.repairing && (state.phase === "thinking" || state.phase === "writing") ? "编译出错,自动修复中…" : LABEL[state.phase];
  return (
    <div className={`canvas ${fit ? "canvas--fit" : ""} ${busy ? "canvas--busy" : ""}`}>
      {state.phase === "error" && state.error ? (
        <div className="canvas__error">
          <h3>{state.error.title}</h3>
          {state.error.detail && <div>{state.error.detail}</div>}
          {state.error.errors?.length ? (
            <ul>{state.error.errors.map((e, i) => <li key={i}>{e.line !== null ? `第 ${e.line} 行:` : ""}{e.message}</li>)}</ul>
          ) : null}
          {state.error.log && <details><summary>完整日志(尾部)</summary><pre>{state.error.log}</pre></details>}
        </div>
      ) : state.svg ? (
        // The svg is produced by our own dvisvgm run and sanitized server-side; only one inline copy lives in the DOM.
        <div className="canvas__img" dangerouslySetInnerHTML={{ __html: state.svg }} />
      ) : (
        <div className="canvas__empty">
          <h2>用一句话生成矢量图</h2>
          <p>Claude 写 TikZ 代码,本机 LaTeX 编译,dvisvgm 输出 SVG。没有图像模型,线条与文字全是矢量。试试左侧的示例。</p>
        </div>
      )}
      {busy && <div className="canvas__overlay"><span>{label}</span></div>}
    </div>
  );
}
