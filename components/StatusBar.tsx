"use client";

import type { GenerationState, Phase } from "@/hooks/useGeneration";

const STEPS: Array<{ key: Phase; label: string }> = [
  { key: "thinking", label: "思考" },
  { key: "writing", label: "写 TikZ" },
  { key: "compiling", label: "编译" },
  { key: "done", label: "完成" },
];
const ORDER: Phase[] = ["idle", "thinking", "writing", "compiling", "done", "error"];

const fmt = (ms: number | null) => (ms === null ? "" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export function StatusBar({ state }: { state: GenerationState }) {
  const idx = ORDER.indexOf(state.phase);
  const active = (p: Phase) => state.phase === p;
  const repairingNow = state.repairing && (state.phase === "thinking" || state.phase === "writing");
  const done = (p: Phase) => idx > ORDER.indexOf(p) && state.phase !== "error";
  return (
    <div className="panel"><div className="panel__body status">
      {STEPS.map((s) => (
        <span key={s.key} className={`status__step ${active(s.key) ? "status__step--active" : done(s.key) ? "status__step--done" : ""}`}>
          <span className={`dot ${active(s.key) && s.key !== "done" ? "dot--pulse" : ""}`} />
          {s.key === "writing" && repairingNow ? "自动修复" : s.label}
          {s.key === "writing" && state.phase === "writing" && ` · ${state.code.length} 字符`}
          {s.key === "writing" && state.llmMs !== null && state.phase !== "writing" && state.phase !== "thinking" && ` ${fmt(state.llmMs)}`}
          {s.key === "compiling" && state.compileMs !== null && ` ${fmt(state.compileMs)}${state.cached ? " · 缓存" : ""}`}
          {s.key === "done" && state.totalMs !== null && ` ${fmt(state.totalMs)}`}
        </span>
      ))}
      {state.phase === "error" && <span className="status__step" style={{ color: "var(--danger)" }}>出错</span>}
      <span className="status__meta">
        {state.model && `${state.model}`}
        {state.usage && ` · ${state.usage.output_tokens} out${state.usage.cache_read_input_tokens ? " · cache hit" : ""}`}
        {state.engine && ` · ${state.engine}`}
        {state.repaired && " · 已修复 1 次"}
      </span>
    </div></div>
  );
}
