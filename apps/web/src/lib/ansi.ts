// Colors for command output in the chat: real ANSI SGR codes when present, otherwise a light ccze-style highlight.
// Colors 0..15 are indexes into the terminal palette (Settings → terminal colors), anything else is a CSS color.

export interface Segment {
  text: string;
  fg?: number | string;
  bg?: number | string;
  bold?: boolean;
  dim?: boolean;
}

// SGR (group 1) is applied; cursor moves, OSC titles and other escapes are dropped.
const ESC = /\x1b\[([0-9;:]*)m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

function color256(n: number): number | string {
  if (n < 16) return n;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const lv = [0, 95, 135, 175, 215, 255];
  return `rgb(${lv[Math.floor(i / 36)]},${lv[Math.floor(i / 6) % 6]},${lv[i % 6]})`;
}

export function parseAnsi(text: string): Segment[] {
  const out: Segment[] = [];
  let style: Omit<Segment, "text"> = {};
  let last = 0;
  for (const m of text.matchAll(ESC)) {
    if (m.index > last) out.push({ ...style, text: text.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[1] === undefined) continue;
    const codes = m[1] === "" ? [0] : m[1].split(/[;:]/).map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) style = {};
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 22) style.bold = style.dim = undefined;
      else if (c >= 30 && c <= 37) style.fg = c - 30;
      else if (c >= 90 && c <= 97) style.fg = c - 82;
      else if (c === 39) style.fg = undefined;
      else if (c >= 40 && c <= 47) style.bg = c - 40;
      else if (c >= 100 && c <= 107) style.bg = c - 92;
      else if (c === 49) style.bg = undefined;
      else if (c === 38 || c === 48) {
        const key = c === 38 ? "fg" : "bg";
        if (codes[i + 1] === 5) {
          style[key] = color256(codes[i + 2] ?? 0);
          i += 2;
        } else if (codes[i + 1] === 2) {
          style[key] = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
          i += 4;
        }
      }
    }
  }
  if (last < text.length) out.push({ ...style, text: text.slice(last) });
  return out;
}

// Order matters: the first group that matches wins. Colors: 1 red, 3 yellow, 2 green, 5 magenta, 4 blue, 6 cyan.
const TOKENS: Array<[string, number]> = [
  [/\b(?:errors?|fail(?:ed|ure)?|fatal|denied|refused|critical|panic|unreachable|inactive|dead|down)\b/.source, 1],
  [/\b(?:warn(?:ing)?s?|deprecated|degraded|time(?:d ?)?out)\b/.source, 3],
  [/\b(?:ok|active|running|enabled|success(?:ful)?|succeeded|up|online|healthy|listen)\b/.source, 2],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?(?::\d+)?\b/.source, 5],
  [/(?<![\w.~-])\/[\w.@+/-]+/.source, 4],
  [/\b\d+(?:[.,]\d+)?(?:%|[KMGTP]i?B?\b|ms\b|s\b|\b)/.source, 6],
];
const TOKEN_RE = new RegExp(TOKENS.map(([s]) => `(${s})`).join("|"), "gi");

export function highlight(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m[0] === "") continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], fg: TOKENS[m.slice(1).findIndex((g) => g !== undefined)]![1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export const colorize = (text: string): Segment[] => (text.includes("\x1b") ? parseAnsi(text) : highlight(text));
