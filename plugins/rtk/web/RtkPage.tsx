import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/utils";
import { fmtDateTime, fmtNumber } from "@/i18n";
import type { RtkStats, RtkTotals, RtkVersion } from "./types";
import { RTK_CHECKED } from "./RtkUpdate";
import { t } from "./i18n";

const RELOAD_MS = 30_000;
const TH = "px-3 py-1.5 text-left font-medium";
const TD = "border-t border-border px-3 py-1.5";

/* ── Helpers ────────────────────────────────────────────────────────────────── */

const tokens = (bytes: number) => Math.round(bytes / 4);
const saved = (t: RtkTotals) => t.bytesIn - t.bytesOut;
const pct = (t: Pick<RtkTotals, "bytesIn" | "bytesOut">) => (t.bytesIn ? Math.round((1 - t.bytesOut / t.bytesIn) * 100) : 0);
const fmtTokens = (bytes: number) => t("tokens", { n: fmtNumber(tokens(bytes)) });

function methodLabel(method: string): string {
  if (method === "compact") return t("method.compact");
  if (method.startsWith("rtk:")) return `rtk · ${method.slice(4)}`;
  return method;
}

/* ── Card component ─────────────────────────────────────────────────────────── */

function TotalsCard({ title, totals }: { title: string; totals: RtkTotals }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="mt-1 text-xl font-semibold">{fmtTokens(saved(totals))}</div>
      <div className="text-sm text-primary">{pct(totals)}%</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {t("totals.counts", { commands: totals.commands, compressed: totals.compressed })}
      </div>
    </div>
  );
}

/* ── Page component ─────────────────────────────────────────────────────────── */

export default function RtkPage() {
  const [stats, setStats] = useState<RtkStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStats(await api.plugin<RtkStats>("rtk", "GET", "/stats"));
      setError(null);
    } catch (err: unknown) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, RELOAD_MS);
    return () => clearInterval(interval);
  }, [load]);

  const reset = async () => {
    if (!window.confirm(t("confirmReset"))) return;
    try {
      await api.plugin("rtk", "DELETE", "/stats");
      await load();
    } catch (err: unknown) {
      setError(errorText(err));
    }
  };

  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  // A found release shows up as the corner update card.
  const check = async () => {
    setChecking(true);
    try {
      const v = await api.plugin<RtkVersion>("rtk", "GET", "/version?refresh=1");
      setCheckNote(v.mode === "external" ? t("update.external") : (v.error ?? (v.updateAvailable ? t("update.available", { latest: v.latest ?? "" }) : t("update.upToDate"))));
      window.dispatchEvent(new Event(RTK_CHECKED));
    } catch (err: unknown) {
      setCheckNote(errorText(err));
    } finally {
      setChecking(false);
    }
  };

  const maxDay = Math.max(1, ...(stats?.daily ?? []).map(saved));

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <h1 className="text-sm font-medium truncate">{t("title")}</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => load()}>
            <RefreshCw className="size-3.5" />
            {t("refresh")}
          </Button>
          <Button size="sm" variant="ghost" className="hover:text-destructive" onClick={reset}>
            <Trash2 className="size-3.5" />
            {t("reset")}
          </Button>
        </div>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <p className="text-xs text-muted-foreground">
          {t("intro")}
        </p>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {stats === null && !error && (
          <div className="flex items-center text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="ml-2">{t("loading")}</span>
          </div>
        )}

        {stats && (
          <>
            {/* Binary status */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{stats.binary ? `rtk ${stats.binary.version} · ${stats.binary.path}` : t("binary.missing")}</span>
              <Button size="xs" variant="outline" disabled={checking} onClick={() => void check()}>
                {checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                {t("update.check")}
              </Button>
              {checkNote && <span>{checkNote}</span>}
            </div>

            {/* Cards */}
            <div className="grid gap-3 sm:grid-cols-2">
              <TotalsCard title={t("today")} totals={stats.today} />
              <TotalsCard title={t("total")} totals={stats.total} />
            </div>

            {/* Daily chart */}
            <section>
              <h2 className="mb-2 text-sm font-medium">{t("daily.title")}</h2>
              {stats.daily.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("noData")}</p>
              ) : (
                <div className="flex h-24 items-end gap-0.5 rounded-lg border border-border bg-card p-2">
                  {stats.daily.map((d) => (
                    <div
                      key={d.day}
                      className="flex-1 rounded-t bg-primary"
                      style={{ height: `${(saved(d) / maxDay) * 100}%` }}
                      title={`${d.day}: ${fmtTokens(saved(d))}`}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* By method */}
            <section>
              <h2 className="mb-2 text-sm font-medium">{t("methods.title")}</h2>
              {stats.methods.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("noData")}</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border bg-card">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className={TH}>{t("col.method")}</th>
                        <th className={TH}>{t("col.commands")}</th>
                        <th className={TH}>{t("col.saved")}</th>
                        <th className={TH}>{t("col.tokens")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.methods.map((m) => (
                        <tr key={m.method}>
                          <td className={TD}>{methodLabel(m.method)}</td>
                          <td className={TD}>{m.commands}</td>
                          <td className={TD}>{pct(m)}%</td>
                          <td className={TD}>{fmtNumber(tokens(saved(m)))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Recent runs */}
            <section>
              <h2 className="mb-2 text-sm font-medium">{t("recent.title")}</h2>
              {stats.recent.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("noData")}</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border bg-card">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className={TH}>{t("col.time")}</th>
                        <th className={TH}>{t("col.command")}</th>
                        <th className={TH}>{t("col.method")}</th>
                        <th className={TH}>{t("col.bytes")}</th>
                        <th className={TH}>{t("col.saved")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.recent.map((r) => (
                        <tr key={r.id} className="hover:bg-muted/30">
                          <td className={`${TD} whitespace-nowrap`}>
                            <Link
                              to={`/nodes/${r.nodeId}/tasks/${r.taskId}`}
                              className="underline hover:text-foreground"
                            >
                              {fmtDateTime(r.ts)}
                            </Link>
                          </td>
                          <td className={TD}>
                            <code className="block max-w-md truncate font-mono" title={r.command}>
                              {r.command}
                            </code>
                          </td>
                          <td className={`${TD} whitespace-nowrap`}>{methodLabel(r.method)}</td>
                          <td className={`${TD} whitespace-nowrap`}>
                            {t("bytesRange", { from: r.bytesIn, to: r.bytesOut })}
                          </td>
                          <td className={TD}>{pct(r)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
