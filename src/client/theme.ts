export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "textlibrary.theme";

export const THEME_OPTIONS: { id: ThemePreference; label: string; title: string; icon: string }[] = [
  { id: "light", label: "日间", title: "日间模式", icon: "☀" },
  { id: "dark", label: "夜晚", title: "夜晚模式", icon: "☾" },
  { id: "system", label: "系统", title: "跟随系统", icon: "◐" },
];

type ThemeListener = (resolved: ResolvedTheme, preference: ThemePreference) => void;

const listeners = new Set<ThemeListener>();
let media: MediaQueryList | null = null;
let preference: ThemePreference = "system";
let resolved: ResolvedTheme = "dark";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolvePreference(pref: ThemePreference): ResolvedTheme {
  if (pref === "light" || pref === "dark") return pref;
  return systemPrefersDark() ? "dark" : "light";
}

function readStoredPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    /* ignore quota / private mode */
  }
  return "system";
}

function writeStoredPreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
}

function applyDom(next: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = next;
  root.style.colorScheme = next;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", next);
}

function notify(): void {
  for (const listener of listeners) listener(resolved, preference);
}

function onSystemChange(): void {
  if (preference !== "system") return;
  const next = resolvePreference("system");
  if (next === resolved) return;
  resolved = next;
  applyDom(resolved);
  notify();
}

function ensureMediaListener(): void {
  if (media || typeof window === "undefined") return;
  media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onSystemChange);
}

/** Apply preference to the document and notify subscribers. */
export function setThemePreference(pref: ThemePreference): void {
  preference = pref;
  writeStoredPreference(pref);
  ensureMediaListener();
  resolved = resolvePreference(pref);
  applyDom(resolved);
  notify();
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved;
}

export function onThemeChange(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Call once at startup (before first paint when possible). */
export function initTheme(): ResolvedTheme {
  preference = readStoredPreference();
  resolved = resolvePreference(preference);
  applyDom(resolved);
  ensureMediaListener();
  return resolved;
}
