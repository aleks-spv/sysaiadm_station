import { useState, type ReactNode } from "react";
import { Check, Cpu, Database, HardDrive, LoaderCircle, MemoryStick, Network, RefreshCw, Server } from "lucide-react";
import type { NodeFacts } from "@sysadm/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/i18n";
import { t } from "@/i18n/app";

const UNITS = t("card.bytes").split(",");

export function bytes(n: number): string {
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${UNITS[i]}`;
}

function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? t("card.uptimeDays", { d, h }) : h ? t("card.uptimeHours", { h, m }) : t("card.uptimeMinutes", { m });
}

function ago(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return t("card.justNow");
  if (min < 60) return t("card.minAgo", { n: min });
  if (min < 48 * 60) return t("card.hoursAgo", { n: Math.round(min / 60) });
  return fmtDate(ts);
}

const VIRT: Record<string, string> = { kvm: "KVM", qemu: "QEMU", vmware: "VMware", microsoft: "Hyper-V", xen: "Xen", oracle: "VirtualBox", lxc: "LXC", "lxc-libvirt": "LXC", docker: "Docker", wsl: "WSL" };

function Bar({ used, total }: { used: number; total: number }) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted" title={`${Math.round(pct)}%`}>
      <div className={cn("h-full rounded-full", pct >= 95 ? "bg-destructive" : pct >= 85 ? "bg-amber-500" : "bg-primary")} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Tile({ icon: Icon, title, aside, children, className }: { icon: typeof Cpu; title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0 rounded-xl border bg-card/60 p-3.5", className)}>
      <header className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Icon className="size-3.5" /> {title}
        {aside && <span className="ml-auto font-normal tracking-normal normal-case">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

// Click to copy: addresses and MACs are what you need to paste elsewhere.
function Copyable({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={t("common.copy")}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1000);
        })
      }
      className={cn("inline-flex items-center gap-1 rounded font-mono hover:text-primary", className)}
    >
      {text}
      {done && <Check className="size-3 text-emerald-500" />}
    </button>
  );
}

function Empty({ busy, error, onCollect }: { busy: boolean; error: string | null; onCollect?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card/40 px-6 py-8 text-center">
      <Server className="size-6 text-muted-foreground" />
      <div>
        <p className="text-sm font-medium">{t("card.emptyTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("card.emptyHint")}</p>
      </div>
      {onCollect && (
        <Button size="sm" onClick={onCollect} disabled={busy}>
          {busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />} {t("card.collect")}
        </Button>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// Server card: everything about the box at a glance. Data comes from /init (POST /api/nodes/:id/facts).
export default function NodeCard({ facts, busy, error, onCollect }: { facts: NodeFacts | null; busy: boolean; error: string | null; onCollect?: () => void }) {
  if (!facts) return <Empty busy={busy} error={error} onCollect={onCollect} />;
  const { cpu, memory } = facts;
  const used = memory.availableBytes !== null ? memory.totalBytes - memory.availableBytes : null;
  const virtual = facts.virtualization && facts.virtualization !== "none";

  return (
    <div className="flex flex-col gap-3 text-left">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <Copyable text={facts.hostname} className="max-w-full truncate text-lg font-semibold" />
          <p className="mt-0.5 text-sm text-muted-foreground">
            {facts.os}
            {facts.kernel && <span className="font-mono text-xs"> · {facts.kernel}</span>}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
            <span className={cn("rounded-md px-1.5 py-0.5", virtual ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>
              {virtual ? t("card.vm", { virt: VIRT[facts.virtualization!] ?? facts.virtualization! }) : t("card.metal")}
            </span>
            {facts.vendor && <span className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">{facts.vendor}</span>}
            {facts.uptimeSec !== null && <span className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">{t("card.uptime", { time: uptime(facts.uptimeSec) })}</span>}
          </div>
        </div>
        {onCollect && (
          <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
            {error ? <span className="max-w-60 truncate text-destructive" title={error}>{error}</span> : <span>{t("card.collected", { ago: ago(facts.collectedAt) })}</span>}
            <Button size="icon-sm" variant="ghost" onClick={onCollect} disabled={busy} title={t("card.refresh")} aria-label={t("card.refreshLabel")}>
              <RefreshCw className={cn(busy && "animate-spin")} />
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Tile icon={Cpu} title={t("card.cpu")}>
          <p className="text-sm leading-snug font-medium">{cpu.model || t("card.unknown")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {[cpu.sockets && cpu.sockets > 1 ? t("card.sockets", { count: cpu.sockets }) : null, cpu.cores ? t("card.cores", { count: cpu.cores }) : null, cpu.threads ? t("card.threads", { count: cpu.threads }) : null].filter(Boolean).join(" · ")}
          </p>
        </Tile>
        <Tile icon={MemoryStick} title={t("card.memory")} aside={memory.swapBytes ? `swap ${bytes(memory.swapBytes)}` : undefined}>
          <p className="text-sm font-medium">{bytes(memory.totalBytes)}</p>
          {used !== null && (
            <div className="mt-1.5 space-y-1">
              <Bar used={used} total={memory.totalBytes} />
              <p className="text-xs text-muted-foreground">
                {t("card.memUsage", { used: bytes(used), free: bytes(memory.availableBytes!) })}
              </p>
            </div>
          )}
        </Tile>

        {facts.disks.length > 0 && (
          <Tile icon={HardDrive} title={t("card.disks")} aside={t("card.diskCount", { count: facts.disks.length, size: bytes(facts.disks.reduce((s, d) => s + d.sizeBytes, 0)) })}>
            <ul className="space-y-1.5">
              {facts.disks.map((d) => (
                <li key={d.name} className="flex items-baseline gap-2 text-sm">
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{d.name}</span>
                  <span className="min-w-0 flex-1 truncate" title={d.model ?? ""}>
                    {d.model ?? "—"}
                  </span>
                  {d.rotational !== null && <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{d.rotational ? "HDD" : "SSD"}</span>}
                  <span className="shrink-0 text-xs tabular-nums">{bytes(d.sizeBytes)}</span>
                </li>
              ))}
            </ul>
          </Tile>
        )}

        {facts.filesystems.length > 0 && (
          <Tile icon={Database} title={t("card.filesystems")}>
            <ul className="space-y-2">
              {facts.filesystems.map((f) => (
                <li key={f.mount} className="space-y-1">
                  <div className="flex items-baseline gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono" title={f.mount}>
                      {f.mount}
                    </span>
                    <span className="text-muted-foreground">{f.fstype}</span>
                    <span className="tabular-nums">
                      {bytes(f.usedBytes)} / {bytes(f.sizeBytes)}
                    </span>
                  </div>
                  <Bar used={f.usedBytes} total={f.sizeBytes} />
                </li>
              ))}
            </ul>
          </Tile>
        )}

        <Tile icon={Network} title={t("card.network")} className="sm:col-span-2">
          {facts.interfaces.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("card.noAddresses")}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
              {facts.interfaces.map((i) => (
                <li key={i.name} className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className={cn("size-1.5 rounded-full", i.up ? "bg-emerald-500" : "bg-muted-foreground")} />
                    <span className="font-medium">{i.name}</span>
                    {i.mac && <Copyable text={i.mac} className="text-[11px] text-muted-foreground" />}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 pl-3 text-sm">
                    {i.addresses.map((a) => (
                      <Copyable key={a} text={a} />
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {(facts.gateway || facts.dns.length > 0) && (
            <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
              {facts.gateway && (
                <span>
                  {t("card.gateway")} <Copyable text={facts.gateway} className="text-foreground" />
                </span>
              )}
              {facts.dns.length > 0 && (
                <span>
                  DNS{" "}
                  {facts.dns.map((d) => (
                    <Copyable key={d} text={d} className="mr-2 text-foreground" />
                  ))}
                </span>
              )}
            </div>
          )}
        </Tile>
      </div>
    </div>
  );
}
