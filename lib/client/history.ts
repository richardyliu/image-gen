import type { Theme } from "@/lib/tikz/types";

export interface HistoryItem {
  id: string;
  createdAt: number;
  prompt: string;
  code: string;
  libraries: string[];
  theme: Theme;
  svg: string;
  width: number;
  height: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const HISTORY_KEY = "imagegen.history.v1";
export const HISTORY_MAX = 20;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadHistory(storage: StorageLike | null = defaultStorage()): HistoryItem[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed.filter((x) => x && typeof x.code === "string" && typeof x.svg === "string") as HistoryItem[]) : [];
  } catch {
    return [];
  }
}

function save(items: HistoryItem[], storage: StorageLike): HistoryItem[] {
  let list = items;
  while (list.length) {
    try {
      storage.setItem(HISTORY_KEY, JSON.stringify(list));
      return list;
    } catch {
      list = list.slice(0, -1); // storage full: drop the oldest and retry
    }
  }
  try { storage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
  return [];
}

export function pushHistory(item: HistoryItem, storage: StorageLike | null = defaultStorage()): HistoryItem[] {
  if (!storage) return [item];
  const rest = loadHistory(storage).filter((x) => !(x.code === item.code && x.theme === item.theme));
  return save([item, ...rest].slice(0, HISTORY_MAX), storage);
}

export function removeHistory(id: string, storage: StorageLike | null = defaultStorage()): HistoryItem[] {
  if (!storage) return [];
  return save(loadHistory(storage).filter((x) => x.id !== id), storage);
}

export function clearHistory(storage: StorageLike | null = defaultStorage()): void {
  try { storage?.removeItem(HISTORY_KEY); } catch { /* ignore */ }
}
