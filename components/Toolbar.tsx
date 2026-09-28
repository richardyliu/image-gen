"use client";

import { downloadPng, downloadSvg, fileStem } from "@/lib/client/download";
import type { GenerationState } from "@/hooks/useGeneration";
import type { Theme } from "@/lib/tikz/types";

interface Props {
  state: GenerationState;
  theme: Theme;
  fit: boolean;
  onToggleTheme: () => void;
  onToggleFit: () => void;
}

export function Toolbar({ state, theme, fit, onToggleTheme, onToggleFit }: Props) {
  const has = Boolean(state.svg);
  const stem = fileStem(state.prompt);
  const bg = theme === "dark" ? "#18181b" : "#ffffff";
  return (
    <div className="toolbar">
      <button className="btn btn--sm" onClick={() => state.svg && downloadSvg(state.svg, stem)} disabled={!has}>下载 SVG</button>
      <button className="btn btn--sm" onClick={() => state.svg && downloadPng(state.svg, state.width, state.height, stem, bg).catch((e: Error) => alert(e.message))} disabled={!has}>下载 PNG ×2</button>
      <button className="btn btn--sm btn--ghost" onClick={onToggleFit} disabled={!has}>{fit ? "实际大小" : "适应宽度"}</button>
      <span className="toolbar__spacer" />
      {has && <span className="toolbar__size">{Math.round(state.width)}×{Math.round(state.height)} pt</span>}
      <button className="btn btn--sm" onClick={onToggleTheme} aria-label="切换主题">{theme === "dark" ? "☀︎ 浅色" : "☾ 深色"}</button>
    </div>
  );
}
