// Hides secrets in command output before the model reads it. Pure text in, text out.
// shortcut: pattern list, not a secret scanner; catches the common formats (config assignments, PEM keys,
// tokens with known prefixes, URL credentials, shadow hashes). Extend MASKS when a new format leaks.

export const MASK = "***";

// Names whose value is a secret. Matched on the end of the key, so DB_PASSWORD and api_key hit
// while PasswordAuthentication (sshd_config) and PWD (env) do not.
// `pass` and `_pwd` match only at the end: DB_PASS, MYSQL_PWD. Bare PWD (env) stays.
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*?(?:password|passwd|pass|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|preshared[_-]?key|credentials?|_pwd)`;

const MASKS: Array<{ re: RegExp; replace: (...m: string[]) => string }> = [
  // PEM private keys, also a block cut off by truncation (no END line).
  {
    re: /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: (_, begin, end) => `${begin}\n${MASK}\n${end}`,
  },
  // key = value, key: value, "key": "value", --key=value. The separator stays on one line, so a YAML key
  // with a nested block below it is left alone.
  {
    re: new RegExp(String.raw`\b(${SECRET_KEY})(["']?[ \t]*[:=][ \t]*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"']+))`, "gi"),
    replace: (_, key, sep, dq, sq) => `${key}${sep}${dq !== undefined ? `"${MASK}"` : sq !== undefined ? `'${MASK}'` : MASK}`,
  },
  // Space-separated CLI flags: --password hunter2
  {
    re: new RegExp(String.raw`(--${SECRET_KEY}[ \t]+)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)`, "gi"),
    replace: (_, head) => `${head}${MASK}`,
  },
  // Authorization: Bearer … / Basic …
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: (_, scheme) => `${scheme} ${MASK}` },
  // scheme://user:password@host
  { re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, replace: (_, head) => `${head}${MASK}@` },
  // crypt(3) hashes as in /etc/shadow: $6$salt$hash, yescrypt $y$…, bcrypt $2b$…
  { re: /\$(?:1|2[aby]?|5|6|7|y|gy)\$[^\s:]+/g, replace: () => MASK },
  // Tokens with a known prefix.
  {
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    replace: () => MASK,
  },
];

export function maskSecrets(text: string): { text: string; count: number } {
  let count = 0;
  for (const { re, replace } of MASKS) {
    text = text.replace(re, (...args: unknown[]) => {
      const groups = args.slice(0, -2).map((g) => g as string);
      const out = replace(...groups);
      if (out !== groups[0]) count++;
      return out;
    });
  }
  return { text, count };
}
