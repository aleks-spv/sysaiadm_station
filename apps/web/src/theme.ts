import { t } from "@/i18n/app";

export interface Theme {
  id: string;
  label: string;
  classes: string[];
}

// To add a theme: a `.theme-<id>` block in index.css plus an entry here. Keep "dark" in classes, or dark: utilities stop applying.
export const THEMES: Theme[] = [
  { id: "dark", label: t("theme.dark"), classes: ["dark"] },
  { id: "light", label: t("theme.light"), classes: [] },
  // Resolved to dark or light from the OS setting, and follows it while the page is open.
  { id: "system", label: t("theme.system"), classes: [] },
];

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
media?.addEventListener("change", () => {
  if (currentTheme() === "system") applyTheme("system");
});

// The theme actually shown: "system" becomes dark or light.
export function resolvedTheme(id = currentTheme()): "dark" | "light" {
  if (id === "system") return media?.matches ? "dark" : "light";
  return id === "light" ? "light" : "dark";
}

export const DEFAULT_THEME = "dark";
const KEY = "sysadm.theme";

export function currentTheme(): string {
  try {
    const saved = localStorage.getItem(KEY);
    return THEMES.some((t) => t.id === saved) ? (saved as string) : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(id: string): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
  const shown = THEMES.find((t) => t.id === resolvedTheme(theme.id))!;
  const root = document.documentElement;
  for (const t of THEMES) root.classList.remove(...t.classes);
  root.classList.add(...shown.classes);
  try {
    localStorage.setItem(KEY, theme.id);
  } catch {
    // Storage disabled (private mode): the theme still applies for this page load.
  }
}
