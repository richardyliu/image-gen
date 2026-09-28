"use client";

import { svgToDataUrl } from "@/lib/client/download";
import type { HistoryItem } from "@/lib/client/history";

interface Props {
  items: HistoryItem[];
  activeCode: string;
  onSelect: (item: HistoryItem) => void;
  onClear: () => void;
}

export function HistoryStrip({ items, activeCode, onSelect, onClear }: Props) {
  return (
    <section className="panel">
      <div className="panel__head">
        <strong>历史</strong><span>保存在浏览器本地,最近 {items.length} 张</span>
        {items.length > 0 && <button className="btn btn--ghost btn--sm" style={{ marginLeft: "auto" }} onClick={onClear}>清空</button>}
      </div>
      <div className="panel__body">
        {items.length === 0 ? <div className="history__empty">还没有生成过图。</div> : (
          <div className="history">
            {items.map((it) => (
              <button key={it.id} className={`history__item ${it.code === activeCode ? "history__item--active" : ""}`} onClick={() => onSelect(it)} title={it.prompt}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={svgToDataUrl(it.svg)} alt={it.prompt} />
                <span>{it.prompt}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
