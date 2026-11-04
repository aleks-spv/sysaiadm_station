import type { Database } from "bun:sqlite";
import type { NodeFacts, OsKind } from "@sysadm/shared";
import { audit } from "./guard";
import { getNode } from "./inventory";
import { pinHostKeys, planHops } from "./routes/internal";
import { execRemote, HostKeyMismatch, SshHopError, type ExecInput, type ExecOutput } from "./ssh";

// Server card (/init): one fixed read-only script per OS, parsed here. No model, no tokens, no root needed.

const TIMEOUT_MS = 60_000;

// POSIX sh, LC_ALL=C so tools print English field names. Every probe may be missing; its section stays empty.
export const LINUX_SCRIPT = `export LC_ALL=C
s(){ printf '\\n### %s\\n' "$1"; }
s hostname; hostname -f 2>/dev/null || hostname
s os; cat /etc/os-release 2>/dev/null
s kernel; uname -r
s uptime; cat /proc/uptime
s virt; systemd-detect-virt 2>/dev/null
s vendor; cat /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name 2>/dev/null
s cpu; lscpu 2>/dev/null
s mem; cat /proc/meminfo
s disks; lsblk -d -b -n -P -o NAME,MODEL,SIZE,ROTA,TYPE 2>/dev/null
s fs; df -P -B1 -T -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null
s link; ip -o link show 2>/dev/null
s addr; ip -o addr show 2>/dev/null
s route; ip route show default 2>/dev/null
s dns; grep '^nameserver' /etc/resolv.conf 2>/dev/null
s dns2; resolvectl dns 2>/dev/null
true`;

export const WINDOWS_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = @(Get-CimInstance Win32_Processor)
$pd = @(Get-PhysicalDisk)
[ordered]@{
  hostname = if ($cs.Domain -and $cs.PartOfDomain) { "$($cs.DNSHostName).$($cs.Domain)" } else { $env:COMPUTERNAME }
  os = "$($os.Caption) $($os.Version)"
  kernel = $os.Version
  uptimeSec = [int64]((Get-Date) - $os.LastBootUpTime).TotalSeconds
  manufacturer = $cs.Manufacturer
  model = $cs.Model
  cpuModel = $cpu[0].Name
  sockets = $cpu.Count
  cores = ($cpu | Measure-Object NumberOfCores -Sum).Sum
  threads = ($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum
  memTotal = [int64]$cs.TotalPhysicalMemory
  memFree = [int64]$os.FreePhysicalMemory * 1024
  swap = [int64]$os.SizeStoredInPagingFiles * 1024
  disks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object { $i = $_.Index; @{ name = "Disk $i"; model = $_.Model; size = [int64]$_.Size; media = "$(($pd | Where-Object DeviceId -eq "$i").MediaType)" } })
  fs = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ mount = $_.DeviceID; fstype = $_.FileSystem; size = [int64]$_.Size; free = [int64]$_.FreeSpace } })
  nics = @(Get-NetAdapter | ForEach-Object { $a = $_; @{ name = $a.Name; mac = $a.MacAddress; up = ($a.Status -eq 'Up'); addresses = @(Get-NetIPAddress -InterfaceIndex $a.ifIndex | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" }) } })
  gateway = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop
  dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses } | Select-Object -Unique)
} | ConvertTo-Json -Depth 5 -Compress`;

// Container and VM plumbing: docker, k8s CNIs, Proxmox tap/fw bridges, libvirt NAT. vmbr*/bond*/vlan stay.
const NOISE_IF = /^(lo|docker\d*|br-[0-9a-f]{12}|veth|cni|flannel|cali|cilium|lxc|kube-|tap\d|fwbr|fwpr|fwln|vnet\d|virbr|tunl0|vxlan|weave|datapath|genev_sys|ovs-system|vEthernet \((WSL|nat|Default Switch)|Loopback)/i;

const toNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

// Link-local and loopback addresses say nothing about where the server is.
const usefulAddress = (a: string) => !/^(fe80:|169\.254\.|127\.|::1\/)/i.test(a);

function virtFromVendor(vendor: string | null): string | null {
  if (!vendor) return null;
  if (/vmware/i.test(vendor)) return "vmware";
  if (/microsoft.*virtual|virtual machine/i.test(vendor)) return "microsoft";
  if (/qemu|kvm|standard pc|proxmox/i.test(vendor)) return "kvm";
  if (/xen/i.test(vendor)) return "xen";
  if (/virtualbox|innotek/i.test(vendor)) return "oracle";
  return null;
}

function sections(output: string): Map<string, string> {
  const map = new Map<string, string>();
  const parts = output.split(/^### (\w+)$/m);
  for (let i = 1; i < parts.length; i += 2) map.set(parts[i], parts[i + 1].trim());
  return map;
}

function kv(text: string, sep: RegExp): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = sep.exec(line);
    if (m) map.set(m[1].trim(), m[2].trim());
  }
  return map;
}

export function parseLinuxFacts(output: string, now: number): NodeFacts {
  const s = sections(output);
  const get = (k: string) => s.get(k) ?? "";

  const osr = kv(get("os"), /^(\w+)=(.*)$/);
  const unquote = (v = "") => v.replace(/^"|"$/g, "");
  const cpu = kv(get("cpu"), /^([^:]+):\s*(.*)$/);
  const mem = kv(get("mem"), /^(\w+):\s+(\d+)/);
  const kb = (k: string) => (mem.has(k) ? Number(mem.get(k)) * 1024 : null);
  const vendorLines = get("vendor").split("\n").map((l) => l.trim()).filter(Boolean);
  const vendor = vendorLines.length ? vendorLines.join(" ") : null;
  const virtRaw = get("virt").split("\n")[0]?.trim() || null;

  const disks: NodeFacts["disks"] = [];
  for (const line of get("disks").split("\n")) {
    const f = Object.fromEntries([...line.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (f.TYPE !== "disk" || /^(loop|ram|zram|sr)/.test(f.NAME ?? "")) continue;
    disks.push({ name: f.NAME, model: f.MODEL?.trim() || null, sizeBytes: toNum(f.SIZE) ?? 0, rotational: f.ROTA === "1" ? true : f.ROTA === "0" ? false : null });
  }

  const filesystems: NodeFacts["filesystems"] = [];
  for (const line of get("fs").split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 7) continue;
    const [, fstype, size, used] = cols;
    const mount = cols.slice(6).join(" ");
    // Snap/flatpak loop mounts and container layers are not the server's disks.
    if (/^\/(snap|var\/lib\/docker|run)\b/.test(mount)) continue;
    filesystems.push({ mount, fstype, sizeBytes: toNum(size) ?? 0, usedBytes: toNum(used) ?? 0 });
  }

  const links = new Map<string, { mac: string | null; up: boolean }>();
  for (const line of get("link").split("\n")) {
    const m = /^\d+:\s+([^:@\s]+)(?:@\S+)?:\s+<([^>]*)>/.exec(line);
    const mac = /link\/ether\s+([0-9a-f:]{17})/i.exec(line)?.[1].toLowerCase() ?? null;
    if (m) links.set(m[1], { mac, up: /\bUP\b/.test(m[2]) || /state UP/.test(line) });
  }
  const addrs = new Map<string, string[]>();
  for (const line of get("addr").split("\n")) {
    const m = /^\d+:\s+(\S+)\s+inet6?\s+(\S+)/.exec(line);
    if (!m || !usefulAddress(m[2])) continue;
    const name = m[1].replace(/@.*$/, "");
    addrs.set(name, [...(addrs.get(name) ?? []), m[2]]);
  }
  const interfaces = [...new Set([...links.keys(), ...addrs.keys()])]
    .filter((name) => !NOISE_IF.test(name) && (addrs.get(name)?.length ?? 0) > 0)
    .map((name) => ({ name, mac: links.get(name)?.mac ?? null, up: links.get(name)?.up ?? true, addresses: addrs.get(name) ?? [] }));

  const gateway = /default via (\S+)/.exec(get("route"))?.[1] ?? null;
  const ip = /(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]*:[0-9a-f:]+/gi;
  let dns = [...get("dns").matchAll(/^nameserver\s+(\S+)/gm)].map((m) => m[1]);
  // systemd-resolved stub: the real upstream servers come from resolvectl.
  const upstream = [...new Set(get("dns2").match(ip) ?? [])].filter((d) => !d.startsWith("127.") && !d.startsWith("fe80:"));
  if (dns.every((d) => d.startsWith("127.")) && upstream.length) dns = upstream;

  const sockets = toNum(cpu.get("Socket(s)"));
  const coresPerSocket = toNum(cpu.get("Core(s) per socket"));
  return {
    collectedAt: now,
    hostname: get("hostname").split("\n")[0]?.trim() || "",
    os: unquote(osr.get("PRETTY_NAME")) || "Linux",
    kernel: get("kernel").split("\n")[0]?.trim() || null,
    uptimeSec: toNum(get("uptime").split(/\s+/)[0]) === null ? null : Math.round(toNum(get("uptime").split(/\s+/)[0])!),
    virtualization: virtRaw ?? virtFromVendor(vendor),
    vendor,
    cpu: {
      model: cpu.get("Model name") ?? cpu.get("Model") ?? "",
      sockets,
      cores: sockets !== null && coresPerSocket !== null ? sockets * coresPerSocket : null,
      threads: toNum(cpu.get("CPU(s)")),
    },
    memory: { totalBytes: kb("MemTotal") ?? 0, availableBytes: kb("MemAvailable"), swapBytes: kb("SwapTotal") },
    disks,
    filesystems,
    interfaces,
    gateway,
    dns,
  };
}

export function parseWindowsFacts(output: string, now: number): NodeFacts {
  const start = output.indexOf("{");
  const raw = JSON.parse(start >= 0 ? output.slice(start) : output) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  // ConvertTo-Json turns a one-element array into an object and an empty one into null.
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : v && typeof v === "object" ? [v as Record<string, unknown>] : []);
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((x): x is string => typeof x === "string");
  const vendor = [str(raw.manufacturer), str(raw.model)].filter(Boolean).join(" ") || null;
  return {
    collectedAt: now,
    hostname: str(raw.hostname),
    os: str(raw.os) || "Windows",
    kernel: str(raw.kernel) || null,
    uptimeSec: toNum(raw.uptimeSec),
    virtualization: virtFromVendor(vendor) ?? "none",
    vendor,
    cpu: { model: str(raw.cpuModel), sockets: toNum(raw.sockets), cores: toNum(raw.cores), threads: toNum(raw.threads) },
    memory: { totalBytes: toNum(raw.memTotal) ?? 0, availableBytes: toNum(raw.memFree), swapBytes: toNum(raw.swap) },
    disks: list(raw.disks).map((d) => ({
      name: str(d.name),
      model: str(d.model) || null,
      sizeBytes: toNum(d.size) ?? 0,
      rotational: str(d.media) === "HDD" ? true : str(d.media) === "SSD" ? false : null,
    })),
    filesystems: list(raw.fs).map((f) => {
      const size = toNum(f.size) ?? 0;
      return { mount: str(f.mount), fstype: str(f.fstype), sizeBytes: size, usedBytes: size - (toNum(f.free) ?? 0) };
    }),
    interfaces: list(raw.nics)
      .map((n) => ({
        name: str(n.name),
        mac: str(n.mac).replace(/-/g, ":").toLowerCase() || null,
        up: n.up === true,
        addresses: strings(n.addresses).filter(usefulAddress),
      }))
      .filter((n) => !NOISE_IF.test(n.name) && n.addresses.length > 0),
    gateway: str(raw.gateway) || null,
    dns: strings(raw.dns),
  };
}

// The card is the truth about the OS. Proxmox reports itself as Debian, so a proxmox node stays proxmox;
// an unknown distro keeps whatever the admin set.
export function osFromFacts(facts: NodeFacts, current: OsKind): OsKind {
  if (/windows/i.test(facts.os)) return "windows";
  if (current === "proxmox" && /debian/i.test(facts.os)) return current;
  if (/ubuntu/i.test(facts.os)) return "ubuntu";
  if (/debian/i.test(facts.os)) return "debian";
  if (/proxmox/i.test(facts.os)) return "proxmox";
  return current;
}

export function getFacts(db: Database, nodeId: string): NodeFacts | null {
  const row = db.query<{ facts: string }, [string]>("SELECT facts FROM node_facts WHERE node_id = ?").get(nodeId);
  return row ? (JSON.parse(row.facts) as NodeFacts) : null;
}

// Runs the probe on the node over its usual route and stores the card. Errors are short Russian messages for the UI.
export async function collectFacts(
  db: Database,
  masterKey: Buffer,
  nodeId: string,
  actor: string,
  exec: (input: ExecInput) => Promise<ExecOutput> = execRemote,
  now: () => number = Date.now,
): Promise<NodeFacts> {
  const node = getNode(db, nodeId);
  if (!node) throw new Error("узел не найден");
  let planned: ReturnType<typeof planHops>;
  try {
    planned = planHops(db, masterKey, nodeId);
  } catch (err) {
    const code = err instanceof Error ? err.message : "";
    if (code === "NO_USER") throw new Error("у узла не задан пользователь SSH");
    if (code === "NO_CREDENTIAL" || code === "BAD_CREDENTIAL") throw new Error("у узла нет SSH-кредов");
    if (code.startsWith("JUMP_")) throw new Error(`маршрут через бастион не строится: ${code}`);
    throw err;
  }
  const { eff, hops } = planned;
  const windows = eff.shell === "powershell";
  let out: ExecOutput;
  try {
    out = await exec({ hops: hops.map((h) => h.hop), command: windows ? WINDOWS_SCRIPT : LINUX_SCRIPT, shell: eff.shell, timeoutMs: TIMEOUT_MS });
  } catch (err) {
    if (err instanceof HostKeyMismatch) throw new Error(`ключ хоста «${hops[err.hop]?.name}» изменился; сбросьте его в настройках узла, если это ожидаемо`);
    if (err instanceof SshHopError) throw new Error(`не удалось подключиться к «${hops[err.hop]?.name}»`);
    if (err instanceof Error && err.message === "EXEC_TIMEOUT") throw new Error("сервер не ответил за минуту");
    throw err;
  }
  if (pinHostKeys(db, hops, out.hostKeys) !== null) throw new Error("ключ хоста не совпал с сохранённым");

  let facts: NodeFacts;
  try {
    facts = windows ? parseWindowsFacts(out.stdout, now()) : parseLinuxFacts(out.stdout, now());
  } catch {
    throw new Error(`не удалось разобрать ответ сервера: ${(out.stderr || out.stdout).slice(0, 200)}`);
  }
  if (!facts.hostname && !facts.cpu.model) throw new Error(`сервер ответил пустым выводом (exit ${out.exitCode}): ${out.stderr.slice(0, 200)}`);

  db.run(
    "INSERT INTO node_facts (node_id, facts, collected_at) VALUES (?, ?, ?) ON CONFLICT (node_id) DO UPDATE SET facts = excluded.facts, collected_at = excluded.collected_at",
    [nodeId, JSON.stringify(facts), facts.collectedAt],
  );
  const os = osFromFacts(facts, node.os);
  if (os !== node.os) db.run("UPDATE nodes SET os = ? WHERE id = ?", [os, nodeId]);
  audit(db, { actor, action: "facts_collect", nodeId, detail: { hostname: facts.hostname } });
  return facts;
}

const gib = (b: number) => `${(b / 1024 ** 3).toFixed(b >= 100 * 1024 ** 3 ? 0 : 1)} ГиБ`;

// Short hardware section for the node's AGENTS.md, so the agent does not spend commands on it.
export function factsMarkdown(f: NodeFacts): string {
  const lines = [
    `## Карточка сервера (собрана ${new Date(f.collectedAt).toISOString().slice(0, 16).replace("T", " ")} UTC)`,
    `- Хост: ${f.hostname}; ${f.os}${f.kernel ? `, ядро ${f.kernel}` : ""}${f.virtualization && f.virtualization !== "none" ? `; виртуалка (${f.virtualization})` : ""}`,
    `- CPU: ${f.cpu.model}${f.cpu.threads ? `, ${f.cpu.threads} потоков` : ""}; RAM ${gib(f.memory.totalBytes)}`,
  ];
  if (f.disks.length) lines.push(`- Диски: ${f.disks.map((d) => `${d.name} ${d.model ?? ""} ${gib(d.sizeBytes)}`.replace(/\s+/g, " ")).join("; ")}`);
  if (f.interfaces.length) lines.push(`- Сеть: ${f.interfaces.map((i) => `${i.name} ${i.addresses.join(", ")}`).join("; ")}${f.gateway ? `; шлюз ${f.gateway}` : ""}`);
  return lines.join("\n");
}
