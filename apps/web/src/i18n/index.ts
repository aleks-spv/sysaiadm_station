// UI languages. To add one: an entry in LANGS, then a `<lang>` block next to `en` in every defineMessages() call
// (apps/web/src/i18n/*.ts and plugins/*/web/i18n.ts). Missing keys fall back to English. See docs/i18n.md.
export const LANGS = [
  { id: "ru", label: "Русский" },
  { id: "en", label: "English" },
] as const;

export type Lang = (typeof LANGS)[number]["id"];

// Plural forms follow Intl.PluralRules: ru uses one/few/many, en uses one/other.
export type Plural = { one: string; few?: string; many?: string; other: string };
export type Msg = string | Plural;
export type Vars = Record<string, string | number>;

const KEY = "sysadm.lang";

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.some((l) => l.id === saved)) return saved as Lang;
  } catch {
    // Storage disabled: fall through to the browser language.
  }
  const nav = typeof navigator === "undefined" ? "" : (navigator.language ?? "").toLowerCase();
  return nav.startsWith("ru") ? "ru" : "en";
}

// shortcut: the language is fixed for the page lifetime and setLang() reloads, so module-level constants can call t();
// switch to a reactive store if reloading ever loses state that matters.
export const lang: Lang = detect();
export const locale = lang === "ru" ? "ru-RU" : "en-US";

if (typeof document !== "undefined") document.documentElement.lang = lang;

export function setLang(next: Lang): void {
  if (next === lang) return;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    return;
  }
  location.reload();
}

const plurals = new Intl.PluralRules(locale);

export function format(msg: Msg, vars?: Vars): string {
  let text: string;
  if (typeof msg === "string") text = msg;
  else {
    const count = Number(vars?.count ?? 0);
    text = msg[plurals.select(count) as keyof Plural] ?? msg.other;
  }
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
}

// Dictionaries for one area of the UI. Russian is the source, English must have every key (checked by tsc),
// other languages may be partial.
export function defineMessages<R extends Record<string, Msg>>(
  dicts: { ru: R; en: { [K in keyof R]: Msg } } & Partial<Record<Lang, Partial<Record<keyof R, Msg>>>>,
): (key: keyof R & string, vars?: Vars) => string {
  const own = dicts[lang] as Partial<Record<keyof R, Msg>> | undefined;
  return (key, vars) => format(own?.[key] ?? dicts.en[key] ?? dicts.ru[key], vars);
}

export const fmtDate = (ts: number) => new Date(ts).toLocaleDateString(locale);
export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString(locale);
export const fmtDateTime = (ts: number) => new Date(ts).toLocaleString(locale);
export const fmtNumber = (n: number) => n.toLocaleString(locale);
