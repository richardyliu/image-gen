"use client";

import type { KeyboardEvent } from "react";

export const EXAMPLES = [
  "动物细胞结构图,标注细胞核、线粒体、内质网、高尔基体",
  "TCP 三次握手时序图",
  "二叉搜索树依次插入 5, 3, 8, 1, 4 后的结构",
  "y = sin x 与 y = cos x 在 [0, 2π] 上的函数图像",
  "一个简单的 RC 低通滤波电路",
  "机器学习训练流程图:数据 → 预处理 → 模型 → 评估 → 部署",
];

interface Props {
  busy: boolean;
  value: string;
  onChange: (value: string) => void;
  onGenerate: (prompt: string) => void;
  onCancel: () => void;
}

export function PromptBar({ busy, value, onChange, onGenerate, onCancel }: Props) {
  const setValue = onChange;
  const submit = () => { const p = value.trim(); if (p && !busy) onGenerate(p); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  };
  return (
    <section className="panel prompt">
      <div className="panel__head"><strong>描述你要的图</strong><span>自然语言 → TikZ → SVG</span></div>
      <div className="panel__body">
        <textarea value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} placeholder="例如:动物细胞结构图,标注细胞核、线粒体……" aria-label="提示词" />
        <div className="prompt__row">
          <button className="btn btn--primary" onClick={submit} disabled={busy || !value.trim()}>{busy ? "生成中…" : "生成"}</button>
          {busy && <button className="btn btn--ghost" onClick={onCancel}>取消</button>}
          <span className="prompt__hint">⌘/Ctrl + Enter</span>
        </div>
        <div className="chips">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip" onClick={() => { setValue(ex); if (!busy) onGenerate(ex); }}>{ex.length > 22 ? ex.slice(0, 22) + "…" : ex}</button>
          ))}
        </div>
      </div>
    </section>
  );
}
