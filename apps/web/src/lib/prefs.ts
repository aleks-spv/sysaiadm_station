import { useSyncExternalStore } from "react";
import { t } from "@/i18n/app";

// Per-browser look and behaviour (Settings → General). Applied as CSS variables on <html>; nothing goes to the server.

export interface Accent {
  id: string;
  label: string;
  hue: number;
  chroma: number;
}

// oklch hue/chroma; lightness is picked per theme in applyPrefs.
export const ACCENTS: Accent[] = [
  { id: "amber", label: t("accent.amber"), hue: 70, chroma: 0.12 },
  { id: "orange", label: t("accent.orange"), hue: 45, chroma: 0.16 },
  { id: "red", label: t("accent.red"), hue: 25, chroma: 0.17 },
  { id: "pink", label: t("accent.pink"), hue: 350, chroma: 0.15 },
  { id: "violet", label: t("accent.violet"), hue: 295, chroma: 0.15 },
  { id: "blue", label: t("accent.blue"), hue: 255, chroma: 0.14 },
  { id: "sky", label: t("accent.sky"), hue: 225, chroma: 0.12 },
  { id: "teal", label: t("accent.teal"), hue: 185, chroma: 0.11 },
  { id: "green", label: t("accent.green"), hue: 150, chroma: 0.14 },
  { id: "lime", label: t("accent.lime"), hue: 125, chroma: 0.15 },
  { id: "graphite", label: t("accent.graphite"), hue: 70, chroma: 0 },
];

export interface FontOption {
  id: string;
  label: string;
  stack: string;
}

const MONO_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export const UI_FONTS: FontOption[] = [
  { id: "geist", label: "Geist", stack: "'Geist Variable', sans-serif" },
  { id: "inter", label: "Inter", stack: "'Inter Variable', sans-serif" },
  { id: "onest", label: "Onest", stack: "'Onest Variable', sans-serif" },
  { id: "manrope", label: "Manrope", stack: "'Manrope Variable', sans-serif" },
  { id: "golos", label: "Golos Text", stack: "'Golos Text Variable', sans-serif" },
  { id: "ibm-plex-sans", label: "IBM Plex Sans", stack: "'IBM Plex Sans', sans-serif" },
  { id: "rubik", label: "Rubik", stack: "'Rubik Variable', sans-serif" },
  { id: "system", label: t("font.system"), stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  { id: "mono", label: t("font.mono"), stack: `'JetBrains Mono Variable', ${MONO_FALLBACK}` },
];

export const MONO_FONTS: FontOption[] = [
  { id: "geist-mono", label: "Geist Mono", stack: `'Geist Mono Variable', ${MONO_FALLBACK}` },
  { id: "jetbrains", label: "JetBrains Mono", stack: `'JetBrains Mono Variable', ${MONO_FALLBACK}` },
  { id: "fira-code", label: "Fira Code", stack: `'Fira Code Variable', ${MONO_FALLBACK}` },
  { id: "cascadia", label: "Cascadia Code", stack: `'Cascadia Code Variable', ${MONO_FALLBACK}` },
  { id: "ibm-plex-mono", label: "IBM Plex Mono", stack: `'IBM Plex Mono', ${MONO_FALLBACK}` },
  { id: "source-code-pro", label: "Source Code Pro", stack: `'Source Code Pro Variable', ${MONO_FALLBACK}` },
  { id: "roboto-mono", label: "Roboto Mono", stack: `'Roboto Mono Variable', ${MONO_FALLBACK}` },
  { id: "ubuntu-mono", label: "Ubuntu Mono", stack: `'Ubuntu Mono', ${MONO_FALLBACK}` },
  { id: "martian-mono", label: "Martian Mono", stack: `'Martian Mono Variable', ${MONO_FALLBACK}` },
  { id: "system", label: t("font.system"), stack: MONO_FALLBACK },
];

export interface Prefs {
  accent: string;
  uiFont: string;
  // Root font size in px: every rem-based size (text, spacing) scales with it.
  uiSize: number;
  monoFont: string;
  // Command output and code blocks in the chat, px.
  codeSize: number;
  terminalFont: string;
  terminalSize: number;
  // Line height as a multiple of the font size; xterm's own default (1.0) packs lines tight.
  terminalLineHeight: number;
  // Color scheme id from lib/terminalThemes; "app" follows the UI theme.
  terminalTheme: string;
  // On connect to Linux: colored prompt and ls/grep for the session when the server has none.
  terminalColorize: boolean;
  // Corner radius in rem.
  radius: number;
  chatWidth: "narrow" | "wide" | "full";
  // Command output starts expanded in the chat.
  expandOutput: boolean;
  // Thousands of tokens of task context after which the chat suggests a new task; 0 turns it off.
  contextWarn: number;
  sendKey: "enter" | "mod-enter";
  // Browser notification when a task finishes or waits for approval while the tab is in the background.
  notify: boolean;
  reduceMotion: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  accent: "amber",
  uiFont: "geist",
  uiSize: 14,
  monoFont: "geist-mono",
  codeSize: 12,
  terminalFont: "geist-mono",
  terminalSize: 13,
  terminalLineHeight: 1.25,
  terminalTheme: "one-dark",
  terminalColorize: true,
  radius: 0.625,
  chatWidth: "wide",
  expandOutput: false,
  contextWarn: 180,
  sendKey: "enter",
  notify: false,
  reduceMotion: false,
};

export const LIMITS = {
  uiSize: [12, 18],
  codeSize: [10, 16],
  terminalSize: [10, 20],
  terminalLineHeight: [1, 1.8],
  radius: [0, 1.25],
} as const;

export const CHAT_WIDTH: Record<Prefs["chatWidth"], string> = { narrow: "max-w-2xl", wide: "max-w-4xl", full: "max-w-none" };

const KEY = "sysadm.prefs";
const listeners = new Set<() => void>();

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    // Unknown or stale keys from older versions are dropped by spreading only over known defaults.
    const merged = { ...DEFAULT_PREFS };
    for (const k of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) {
      if (typeof saved[k] === typeof DEFAULT_PREFS[k]) (merged as Record<string, unknown>)[k] = saved[k];
    }
    return merged;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let current = load();

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
const find = <T extends { id: string }>(list: T[], id: string) => list.find((x) => x.id === id) ?? list[0];

export const fontStack = (id: string) => find(MONO_FONTS, id).stack;

export function applyPrefs(p: Prefs = current): void {
  const s = document.documentElement.style;
  const a = find(ACCENTS, p.accent);
  // light-dark() follows color-scheme, which the theme classes set: one value serves both themes.
  const primary = `light-dark(oklch(0.56 ${a.chroma} ${a.hue}), oklch(0.78 ${a.chroma} ${a.hue}))`;
  s.setProperty("--primary", primary);
  s.setProperty("--sidebar-primary", primary);
  s.setProperty("--primary-foreground", `light-dark(oklch(0.985 0 0), oklch(0.2 0.01 ${a.hue}))`);
  s.setProperty("--sidebar-primary-foreground", `light-dark(oklch(0.985 0 0), oklch(0.2 0.01 ${a.hue}))`);
  s.setProperty("--ring", `light-dark(oklch(0.56 ${a.chroma} ${a.hue} / 50%), oklch(0.78 ${a.chroma} ${a.hue} / 60%))`);
  s.setProperty("--app-font-sans", find(UI_FONTS, p.uiFont).stack);
  s.setProperty("--app-font-mono", fontStack(p.monoFont));
  s.setProperty("--code-size", `${clamp(p.codeSize, LIMITS.codeSize)}px`);
  s.setProperty("--radius", `${clamp(p.radius, LIMITS.radius)}rem`);
  s.fontSize = `${clamp(p.uiSize, LIMITS.uiSize)}px`;
  document.documentElement.classList.toggle("reduce-motion", p.reduceMotion);
}

export function getPrefs(): Prefs {
  return current;
}

export function setPrefs(change: Partial<Prefs>): void {
  current = { ...current, ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Storage disabled: the change still applies for this page load.
  }
  applyPrefs(current);
  for (const l of listeners) l();
}

export function resetPrefs(): void {
  setPrefs({ ...DEFAULT_PREFS });
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}
