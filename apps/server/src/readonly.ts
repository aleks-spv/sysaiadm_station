// Read-only commands run without asking the admin. Allowlist only: a command is "read" when every
// pipeline segment starts with a known read-only program used in a read-only way. Anything unknown
// falls back to asking, so a miss here costs a click, not a change on the server.

type Check = (args: string[], segment: string) => boolean;

const ANY: Check = () => true;
const flag = (a: string) => a.startsWith("-");
// First non-flag argument is one of `subs`; `bare` also accepts no subcommand (only flags).
const sub = (subs: string[], bare = false): Check => (a) => {
  const first = a.find((x) => !flag(x));
  return first === undefined ? bare : subs.includes(first);
};
const without = (re: RegExp): Check => (_, seg) => !re.test(seg);
const only = (...allowed: string[]): Check => (a) => a.every((x) => allowed.includes(x));
const all = (...checks: Check[]): Check => (a, seg) => checks.every((c) => c(a, seg));

const LINUX: Record<string, Check> = Object.fromEntries([
  ...[
    "cat", "zcat", "head", "tail", "tac", "nl", "ls", "stat", "file", "wc", "du", "df", "free", "uptime", "uname",
    "whoami", "id", "groups", "w", "who", "last", "lastlog", "printenv", "ps", "pgrep", "pidof", "lsof", "ss",
    "netstat", "ping", "traceroute", "tracepath", "dig", "nslookup", "host", "getent", "lsblk", "blkid", "lscpu",
    "lspci", "lsusb", "lsmod", "dmidecode", "sensors", "findmnt", "vmstat", "iostat", "mpstat", "nproc", "getconf",
    "cut", "tr", "column", "jq", "md5sum", "sha1sum", "sha256sum", "diff", "cmp", "comm", "which", "whereis",
    "readlink", "realpath", "basename", "dirname", "echo", "printf", "true", "test", "pwd", "cd", "grep", "egrep",
    "fgrep", "zgrep", "rg", "arp", "pveversion", "dpkg-query", "lsb_release", "systemd-detect-virt",
  ].map((name) => [name, ANY] as const),
  ["hostname", only("-f", "-I", "-i", "-s", "-d", "-A", "--fqdn", "--short")],
  ["date", without(/\s(-s|--set)\b/)],
  ["top", (_, seg) => /\s-\w*b/.test(seg)],
  ["sort", without(/\s-[a-zA-Z]*o|--output/)],
  ["uniq", (a) => a.filter((x) => !flag(x)).length <= 1],
  ["find", without(/\s-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/)],
  ["sed", without(/\s-[a-zA-Z]*i|--in-place|(?<![-\w])[we]\s/)],
  ["awk", without(/system|getline|\|\s*"|print[^;}]*>/)],
  ["dmesg", without(/\s-[a-zA-Z]*[cCDEn]|--(clear|read-clear|console)/)],
  ["journalctl", without(/--(vacuum|rotate|flush|sync|relinquish|setup-keys|update-catalog)/)],
  ["systemctl", sub(["status", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files", "list-timers", "list-sockets", "list-dependencies", "show", "cat"], true)],
  ["timedatectl", sub(["status", "show", "list-timezones", "timesync-status", "show-timesync"], true)],
  ["hostnamectl", sub(["status"], true)],
  ["localectl", sub(["status"], true)],
  ["loginctl", sub(["list-sessions", "list-users", "session-status", "user-status", "show-session", "show-user"], true)],
  ["networkctl", sub(["list", "status", "lldp"], true)],
  ["resolvectl", sub(["status", "query", "statistics"], true)],
  ["ip", without(/\b(add|del|delete|set|flush|change|replace|append|exec|save|restore|monitor)\b/)],
  ["mount", only("-l")],
  ["swapon", only("--show", "-s", "--summary")],
  ["sysctl", without(/\s-\w*[wp]|--(write|load|system)|=/)],
  ["smartctl", without(/\s(-t|--test|-s|--smart|-o|--offlineauto|-S|--saveauto|-X|--abort)\b/)],
  ["fdisk", (a) => a.includes("-l")],
  ["ethtool", (a) => a.every((x) => !flag(x) || /^-[iSkgaclmTP]$/.test(x))],
  ["apt", sub(["list", "policy", "show", "search", "depends", "rdepends"])],
  ["apt-cache", sub(["policy", "show", "search", "depends", "rdepends", "madison", "showpkg", "stats"])],
  ["dpkg", (a) => a.length > 0 && /^(-[lLsSp]|--(list|listfiles|status|search|print-avail|get-selections|print-architecture|audit)|-C)$/.test(a[0]!)],
  ["rpm", (a) => a[0]?.startsWith("-q") === true],
  ["crontab", (a) => a.includes("-l") && !a.some((x) => /^-[rei]$/.test(x))],
  ["iptables", (a) => a.some((x) => /^-[nvxL]*[LS][nvxL]*$/.test(x)) && a.every((x) => !flag(x) || /^-[LSnvxt]+$/.test(x) || /^--(list|list-rules|line-numbers|numeric|verbose|exact|table)$/.test(x))],
  ["iptables-save", without(/\s(-f|--file)/)],
  ["nft", sub(["list"])],
  ["ufw", sub(["status"])],
  ["wg", sub(["show", "showconf"], true)],
  ["openssl", all(sub(["x509", "s_client", "version", "verify", "crl", "ciphers"]), without(/\s-out\b/))],
  ["certbot", sub(["certificates"])],
  ["nginx", (a) => a.length === 1 && /^-[tTvV]$/.test(a[0]!)],
  ["sshd", (a) => a.length === 1 && /^-[tT]$/.test(a[0]!)],
  ["apachectl", sub(["-t", "-S", "-M", "-v", "configtest"])],
  // `command -v x` only looks up; plain `command x` runs x.
  ["command", (a) => a[0] === "-v" || a[0] === "-V"],
  ["tmux", sub(["has-session", "has", "ls", "list-sessions", "list-windows", "capture-pane"])],
  ["docker", sub(["ps", "images", "inspect", "logs", "stats", "version", "info", "top", "port", "diff"])],
  ["qm", sub(["list", "status", "config", "pending", "showcmd", "listsnapshot"])],
  ["pct", sub(["list", "status", "config", "pending", "listsnapshot", "df"])],
  ["pvesh", sub(["get", "ls"])],
  ["pvecm", sub(["status", "nodes"])],
  ["pvesm", sub(["status", "list"])],
  ["ha-manager", sub(["status"])],
  ["zpool", sub(["status", "list", "iostat", "get", "history"])],
  ["zfs", sub(["list", "get"])],
  ["ceph", sub(["status", "-s", "health", "df"])],
  ["virsh", sub(["list", "dominfo", "domstate", "nodeinfo", "dumpxml", "domblklist", "domiflist", "net-list", "pool-list", "vol-list"])],
  // Windows binaries reachable from PowerShell
  ["ipconfig", without(/\/(release|renew|flushdns|registerdns)/i)],
  ["systeminfo", ANY],
  ["tasklist", ANY],
  ["driverquery", ANY],
  ["tracert", ANY],
  ["sc", sub(["query", "queryex", "qc", "qdescription"])],
  ["wevtutil", sub(["qe", "el", "gl", "gli", "enum-logs"])],
  ["route", sub(["print"])],
]);

// PowerShell: cmdlets with these verbs only read; Out-File, Set-*, Invoke-* and friends do not qualify.
const PS_VERBS = new Set(["get", "test", "select", "where", "sort", "format", "measure", "group", "convertto", "resolve"]);
const PS_ALIASES = new Set(["?", "select", "where", "sort", "ft", "fl", "measure", "out-string"]);

function psSegmentReadOnly(seg: string): boolean {
  const unquoted = seg.replace(/'[^']*'|"[^"]*"/g, "''");
  if (/::|\.\s*[A-Za-z_]\w*\s*\(|&|\bInvoke|\bOut-File|\bTee-Object|\bAdd-Content/i.test(unquoted)) return false;
  for (const [, verb] of unquoted.matchAll(/(?<![\w$.\-\\/:])([A-Za-z]+)-[A-Za-z]+/g)) {
    if (!PS_VERBS.has(verb!.toLowerCase()) && !/^out-string$/i.test(verb!)) return false;
  }
  // Script blocks ({ $_.Status -eq 'Running' }) may hold only properties, operators and literals: no bare words (aliases like rm).
  // Hashtable keys (@{LogName='System'}) are names, not commands.
  for (const block of unquoted.matchAll(/\{([^{}]*)\}/g)) {
    const words = block[1]!.replace(/(?<![$\w])\w+\s*=/g, " ").split(/[\s(),!;=]+/).filter(Boolean);
    if (!words.every((w) => /^(\$[\w.]+|-[a-z]+|[\d.]+|'')$/i.test(w))) return false;
  }
  return true;
}

// Splits on unquoted | || && ; & and newlines outside {} (PowerShell blocks and hashtables);
// collects redirect targets. null = unbalanced quotes.
function split(command: string): { segments: string[]; redirects: string[] } | null {
  const segments: string[] = [];
  const redirects: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') cur += ch + (command[++i] ?? "");
      else {
        if (ch === quote) quote = null;
        cur += ch;
      }
      continue;
    }
    if (ch === "\\") {
      cur += ch + (command[++i] ?? "");
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === "{" || ch === "}") {
      depth += ch === "{" ? 1 : -1;
      cur += ch;
    } else if (ch === ">" || (ch === "&" && command[i + 1] === ">")) {
      cur = cur.replace(/(^|\s)\d$/, "$1"); // the fd number of 2>/dev/null
      let j = ch === "&" ? i + 2 : i + 1;
      if (command[j] === ">") j++;
      let target = command[j] === "&" ? "&" : "";
      if (target) j++;
      while (command[j] === " ") j++;
      while (j < command.length && !/[\s|;&<>]/.test(command[j]!)) target += command[j++];
      redirects.push(target);
      i = j - 1;
      cur += " ";
    } else if (depth === 0 && "|;&\n".includes(ch)) {
      segments.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (quote || depth !== 0) return null;
  segments.push(cur);
  return { segments: segments.map((s) => s.trim()).filter(Boolean), redirects };
}

// Files whose content is a secret: reading them still goes past the admin.
const SECRETS = /shadow|id_(rsa|dsa|ecdsa|ed25519)|_key\b|\.pem\b|\.key\b|\.pfx\b|\.p12\b|password|\.env\b|\.pgpass|\.netrc|credentials|secret|\.kube\/config|wireguard|wg\d*\.conf|\.vault|token/i;

export function isReadOnly(command: string): boolean {
  if (/\$\(|`|<\(|>\(|<</.test(command) || SECRETS.test(command)) return false;
  const parsed = split(command);
  if (!parsed || parsed.segments.length === 0) return false;
  if (!parsed.redirects.every((t) => t === "/dev/null" || t === "&1" || t === "&2" || /^\$null$/i.test(t))) return false;
  return parsed.segments.every((seg) => {
    // Leading VAR=value assignments and `sudo -n` do not change what runs.
    const s = seg.replace(/^(\w+=\S*\s+)+/, "").replace(/^sudo(\s+-[nEH]+)*\s+/, "");
    const [name = "", ...args] = s.split(/\s+/);
    const check = LINUX[name];
    if (check) return check(args, ` ${s}`);
    if (/^[A-Za-z]+-[A-Za-z]+$/.test(name) || PS_ALIASES.has(name.toLowerCase())) {
      const verb = name.split("-")[0]!.toLowerCase();
      return (PS_VERBS.has(verb) || PS_ALIASES.has(name.toLowerCase())) && psSegmentReadOnly(s);
    }
    return false;
  });
}
