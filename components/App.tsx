"use client";

import { useCallback, useState } from "react";
import { Canvas } from "./Canvas";
import { CodePanel } from "./CodePanel";
import { HistoryStrip } from "./HistoryStrip";
import { PromptBar } from "./PromptBar";
import { StatusBar } from "./StatusBar";
import { Toolbar } from "./Toolbar";
import { useGeneration } from "@/hooks/useGeneration";
import { clearHistory, loadHistory, pushHistory, type HistoryItem } from "@/lib/client/history";
import { applyTheme, readStoredTheme, systemTheme } from "@/lib/client/theme";
import type { Theme } from "@/lib/tikz/types";

const BUSY = new Set(["thinking", "writing", "compiling"]);

export function App() {
  // Rendered client-only (see ClientApp), so localStorage can be read in the initializers.
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? systemTheme());
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory());
  const [fit, setFit] = useState(true);
  const [promptText, setPromptText] = useState("");

  const onRendered = useCallback((item: HistoryItem) => setHistory(pushHistory(item)), []);
  const { state, generate, recompile, setCode, cancel, load } = useGeneration({ theme, onRendered });
  const busy = BUSY.has(state.phase);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

  return (
    <div className="app">
      <header className="header">
        <span className="header__title">imagegen</span>
        <span className="header__sub">prompt → TikZ → LaTeX → dvisvgm → SVG</span>
        <span className="header__spacer" />
        {state.model && <span className="badge">{state.model}</span>}
      </header>
      <main className="layout">
        <div className="column">
          <PromptBar busy={busy} value={promptText} onChange={setPromptText} onGenerate={generate} onCancel={cancel} />
          <StatusBar state={state} />
          <CodePanel code={state.code} libraries={state.libraries} busy={busy} streaming={state.phase === "writing"} onChange={setCode} onRecompile={(c) => void recompile(c)} />
        </div>
        <div className="column">
          <Toolbar state={state} theme={theme} fit={fit} onToggleTheme={toggleTheme} onToggleFit={() => setFit((f) => !f)} />
          <Canvas state={state} fit={fit} />
          <HistoryStrip items={history} activeCode={state.code} onSelect={(item) => { setPromptText(item.prompt); load(item); }} onClear={() => { clearHistory(); setHistory([]); }} />
        </div>
      </main>
    </div>
  );
}
