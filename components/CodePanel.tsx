"use client";

import { useState } from "react";
import { copyText } from "@/lib/client/download";

interface Props {
  code: string;
  libraries: string[];
  busy: boolean;
  streaming: boolean;
  onChange: (code: string) => void;
  onRecompile: (code: string) => void;
}

export function CodePanel({ code, libraries, busy, streaming, onChange, onRecompile }: Props) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel code">
      <div className="panel__head">
        <strong>TikZ 代码</strong>
        <span>{streaming ? "流式生成中…" : "可直接编辑后重新编译"}</span>
        <span style={{ marginLeft: "auto" }}>
          <button className="btn btn--ghost btn--sm" onClick={() => setOpen((o) => !o)}>{open ? "收起" : "展开"}</button>
        </span>
      </div>
      {open && (
        <div className="panel__body">
          <textarea value={code} onChange={(e) => onChange(e.target.value)} spellCheck={false} readOnly={streaming} aria-label="TikZ 代码" placeholder="生成后代码会出现在这里" />
          <div className="code__row">
            <button className="btn" onClick={() => onRecompile(code)} disabled={busy || !code.trim()}>重新编译</button>
            <button className="btn btn--ghost" onClick={async () => { setCopied(await copyText(code)); setTimeout(() => setCopied(false), 1500); }} disabled={!code}>{copied ? "已复制" : "复制"}</button>
            <span className="code__libs" title={libraries.join(", ")}>{libraries.length ? `libraries: ${libraries.join(", ")}` : ""}</span>
          </div>
        </div>
      )}
    </section>
  );
}
