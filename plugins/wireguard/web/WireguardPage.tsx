import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Key,
  Loader2,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { serverMsg } from "@/i18n/server";
import { cn, errorText, fieldClass } from "@/lib/utils";
import {
  FILTERS,
  ID_PATTERN,
  type FilterKey,
  type KeyGenResult,
  type Tunnel,
  type TunnelDetail,
  type TunnelListResponse,
  type TunnelSaveResult,
} from "./types";
import { t } from "./i18n";

/* ── Helpers ────────────────────────────────────────────────────────────────── */

function timeAgo(sec: number): string {
  if (!sec || sec === 0) return t("ago.never");
  const diff = Math.floor((Date.now() / 1000) - sec);
  if (diff < 60) return t("ago.sec", { n: diff });
  if (diff < 3600) return t("ago.min", { n: Math.floor(diff / 60) });
  return t("ago.hour", { n: Math.floor(diff / 3600) });
}

function humanBytes(b: number): string {
  const units = [t("unit.b"), t("unit.kb"), t("unit.mb"), t("unit.gb"), t("unit.tb")];
  if (b === 0) return `0 ${units[0]}`;
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function statusDot(t: Tunnel): string {
  switch (t.health) {
    case "connected":
      return "bg-emerald-500";
    case "stale":
    case "no-handshake":
      return "bg-amber-500";
    default:
      return "bg-muted-foreground/40";
  }
}

function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

/* ── Template builder ───────────────────────────────────────────────────────── */

function buildTemplate(privKey: string): string {
  return [
    "[Interface]",
    `PrivateKey = ${privKey}`,
    "Address = 10.0.0.2/32",
    "",
    "[Peer]",
    `PublicKey = ${t("template.peer")}`,
    "Endpoint = host:51820",
    "AllowedIPs = 10.0.0.0/24",
    "PersistentKeepalive = 25",
  ].join("\n");
}

/* ── Row component ──────────────────────────────────────────────────────────── */

interface TunnelRowProps {
  tunnel: Tunnel;
  expanded: boolean;
  onExpand: () => void;
  onUp: (t: Tunnel) => void;
  onDown: (t: Tunnel) => void;
  onRestart: (t: Tunnel) => void;
  onEdit: (t: Tunnel) => void;
  onDelete: (t: Tunnel) => void;
}

function TunnelRow({
  tunnel,
  expanded,
  onExpand,
  onUp,
  onDown,
  onRestart,
  onEdit,
  onDelete,
}: TunnelRowProps) {
  const firstPeer = tunnel.peers[0];
  const rxTotal = tunnel.peers.reduce((a, p) => a + p.rx, 0);
  const txTotal = tunnel.peers.reduce((a, p) => a + p.tx, 0);

  return (
    <div className="border-b border-border px-3 py-1.5 hover:bg-muted/30">
      <div className="flex items-center gap-2 text-sm">
        <button
          onClick={onExpand}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              statusDot(tunnel),
            )}
            title={tunnel.health}
          />
          <span className="font-mono text-xs text-muted-foreground truncate max-w-[7rem]">
            {tunnel.id}
          </span>
          <span className="truncate max-w-[10rem]">{tunnel.label || "—"}</span>
          <span className="truncate max-w-[12rem] text-xs text-muted-foreground">
            {tunnel.address[0] ?? ""}
            {firstPeer?.endpoint ? ` · ${firstPeer.endpoint}` : ""}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">
            {timeAgo(firstPeer?.latestHandshake)}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">
            {humanBytes(rxTotal)} / {humanBytes(txTotal)}
          </span>
          {tunnel.autostart && (
            <span className="text-[11px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground shrink-0">
              {t("autostart")}
            </span>
          )}
          {expanded ? (
            <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {tunnel.state === "up" ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="h-6 gap-1 px-1.5 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onDown(tunnel);
                }}
              >
                {t("action.down")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="h-6 gap-1 px-1.5 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onRestart(tunnel);
                }}
              >
                {t("action.restart")}
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant="outline"
              className="h-6 gap-1 px-1.5 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onUp(tunnel);
              }}
            >
              {t("action.up")}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(tunnel);
            }}
          >
            {t("action.edit")}
          </Button>
          <Button
            size="xs"
            variant="destructive"
            className="h-6 gap-1 px-1.5 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(tunnel);
            }}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
      {tunnel.lastError && (
        <p className="ml-4 mt-0.5 text-xs text-destructive">{serverMsg(tunnel.lastError)}</p>
      )}

      {expanded && (
        <div className="ml-4 mt-1.5 border-t border-border pt-2 text-xs">
          <div className="grid gap-2">
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground shrink-0">PublicKey:</span>
              <div className="flex min-w-0 items-center gap-1">
                <code className="truncate">{tunnel.publicKey}</code>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 shrink-0"
                  onClick={() => copyText(tunnel.publicKey)}
                >
                  <Copy className="size-3" />
                </Button>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground shrink-0">{t("row.addresses")}</span>
              <ul className="list-disc pl-4">
                {tunnel.address.map((a) => (
                  <li key={a}>
                    <code>{a}</code>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground shrink-0">{t("row.peers")}</span>
              <div className="grid w-full gap-1">
                {tunnel.peers.map((p, i) => (
                  <div key={i} className="rounded bg-muted/50 p-2">
                    <div className="flex flex-col gap-0.5">
                      <div>
                        <span className="text-muted-foreground">PublicKey:</span>{" "}
                        <code>{p.publicKey}</code>
                      </div>
                      {p.endpoint && (
                        <div>
                          <span className="text-muted-foreground">Endpoint:</span>{" "}
                          <code>{p.endpoint}</code>
                        </div>
                      )}
                      <div>
                        <span className="text-muted-foreground">AllowedIPs:</span>{" "}
                        <code>{p.allowedIPs.join(", ")}</code>
                      </div>
                      <div className="text-muted-foreground">
                        Handshake: {timeAgo(p.latestHandshake)} · RX: {humanBytes(p.rx)} · TX: {humanBytes(p.tx)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Dialog component ───────────────────────────────────────────────────────── */

interface TunnelFormState {
  id: string;
  label: string;
  autostart: boolean;
  config: string;
}

interface TunnelDialogProps {
  open: boolean;
  tunnel: Tunnel | null;
  onClose: () => void;
  onWarnings: (warnings: string[]) => void;
}

function TunnelDialog({ open, tunnel, onClose, onWarnings }: TunnelDialogProps) {
  const isEdit = !!tunnel;

  const [form, setForm] = useState<TunnelFormState>({
    id: "",
    label: "",
    autostart: true,
    config: "",
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [keygen, setKeygen] = useState<KeyGenResult | null>(null);
  const [showKeygen, setShowKeygen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    if (tunnel) {
      setForm({ id: tunnel.id, label: tunnel.label, autostart: tunnel.autostart, config: "" });
      api
        .plugin<TunnelDetail>("wireguard", "GET", `/tunnels/${tunnel.id}`)
        .then((detail) => setForm((prev) => (prev.id === detail.id ? { ...prev, config: detail.config } : prev)))
        .catch((err: unknown) => setErrors([errorText(err)]));
    } else {
      setForm({ id: "", label: "", autostart: true, config: "" });
    }
    setErrors([]);
    setKeygen(null);
    setShowKeygen(false);
  }, [open, tunnel]);

  const validate = (): string[] => {
    const errs: string[] = [];
    if (!ID_PATTERN.test(form.id)) {
      errs.push(t("validation.idPattern"));
    }
    if (!form.config.trim()) {
      errs.push(t("validation.configRequired"));
    }
    return errs;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      const body: TunnelFormState = { id: form.id, label: form.label.trim(), config: form.config, autostart: form.autostart };
      let result: TunnelSaveResult;
      if (isEdit) {
        result = await api.plugin<TunnelSaveResult>(
          "wireguard",
          "PUT",
          `/tunnels/${form.id}`,
          body,
        );
      } else {
        result = await api.plugin<TunnelSaveResult>("wireguard", "POST", "/tunnels", body);
      }
      if (result.warnings && result.warnings.length > 0) {
        onWarnings(result.warnings);
      } else {
        onClose();
      }
    } catch (err: unknown) {
      setErrors([errorText(err)]);
    } finally {
      setBusy(false);
    }
  };

  const handleKeygen = async () => {
    try {
      const { privateKey, publicKey }: KeyGenResult = await api.plugin(
        "wireguard",
        "POST",
        "/keygen",
      );
      setKeygen({ privateKey, publicKey });
      setForm((prev) => ({
        ...prev,
        config: buildTemplate(privateKey),
      }));
      setShowKeygen(true);
    } catch (err: unknown) {
      setErrors([errorText(err)]);
    }
  };

  const handleFileLoad = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      setForm((prev) => ({
        ...prev,
        config: text,
        id: prev.id || file.name.replace(/\.conf$/i, ""),
      }));
    };
    reader.readAsText(file);
    // Reset input so the same file can be loaded again
    e.target.value = "";
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{isEdit ? t("dialog.editTitle") : t("dialog.addTitle")}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-1.5 text-xs text-muted-foreground">
            <label>
              {t("form.id")}
              <Input
                className="mt-1 font-mono"
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
                disabled={isEdit}
                required
                placeholder="wg0"
              />
            </label>
          </div>

          <div className="grid gap-1.5 text-xs text-muted-foreground">
            <label>
              {t("form.name")}
              <Input
                className="mt-1"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder={t("form.namePlaceholder")}
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={form.autostart}
              onChange={(e) => setForm({ ...form, autostart: e.target.checked })}
              className="size-3.5 rounded border-border"
            />
            {t("form.autostart")}
          </label>

          <div className="grid gap-1.5 text-xs text-muted-foreground">
            <label>
              {t("form.config")}
              <textarea
                className={cn(fieldClass, "font-mono", "field-sizing-content")}
                rows={16}
                value={form.config}
                onChange={(e) => setForm({ ...form, config: e.target.value })}
                placeholder="[Interface]&#10;PrivateKey = ...&#10;Address = 10.0.0.2/32&#10;&#10;[Peer]&#10;PublicKey = ...&#10;Endpoint = host:51820&#10;AllowedIPs = 10.0.0.0/24&#10;PersistentKeepalive = 25"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleKeygen}
              disabled={busy}
            >
              <Key className="size-3.5" />
              {t("keygen.template")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              <FileText className="size-3.5" />
              {t("form.loadConf")}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".conf,.txt"
              className="hidden"
              onChange={handleFileLoad}
            />
          </div>

          {showKeygen && keygen && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <p className="font-medium">
                {t("keygen.generated", { key: keygen.publicKey })}
              </p>
              <p className="mt-1">
                {t("keygen.hint")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="mt-2"
                onClick={() => copyText(keygen.publicKey)}
              >
                <Copy className="size-3" />
                {t("keygen.copy")}
              </Button>
            </div>
          )}

          {errors.length > 0 && (
            <div className="grid gap-1 text-xs text-destructive">
              {errors.map((e, i) => (
                <p key={i}>{e}</p>
              ))}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              {t("dialog.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {isEdit ? t("dialog.save") : t("dialog.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Page component ─────────────────────────────────────────────────────────── */

export default function WireguardPage() {
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Tunnel | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const upCount = tunnels.filter((t) => t.state === "up").length;

  /* ── Polling ─────────────────────────────────────────────────────────────── */

  const poll = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const data = await api.plugin<TunnelListResponse>("wireguard", "GET", "/tunnels");
      setTunnels(
        data.tunnels.map((t) => ({
          ...t,
          autostart: Boolean(t.autostart),
        })),
      );
      setAvailable(data.available);
      setApiError(data.error ? serverMsg(data.error) : null);
    } catch (err: unknown) {
      setApiError(errorText(err));
    }
  }, []);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [poll]);

  /* ── Filtered / searched list ────────────────────────────────────────────── */

  const filtered = tunnels.filter((t) => {
    const q = search.trim().toLowerCase();
    if (q) {
      const hay = [
        t.id,
        t.label,
        ...t.address,
        ...t.peers.map((p) => p.endpoint ?? ""),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    switch (filter) {
      case "connected":
        return t.state === "up";
      case "problems":
        return t.health !== "connected" || t.lastError;
      case "down":
        return t.state === "down";
      default:
        return true;
    }
  });

  /* ── Actions ─────────────────────────────────────────────────────────────── */

  const execAction = async <T = void>(id: string, fn: (tid: string) => Promise<T>) => {
    try {
      await fn(id);
      await poll();
    } catch (err: unknown) {
      setApiError(errorText(err));
    }
  };

  const handleUp = (t: Tunnel) =>
    execAction(t.id, (id) => api.plugin<Tunnel>("wireguard", "POST", `/tunnels/${id}/up`));
  const handleDown = (t: Tunnel) =>
    execAction(t.id, (id) => api.plugin<Tunnel>("wireguard", "POST", `/tunnels/${id}/down`));
  const handleRestart = (t: Tunnel) =>
    execAction(t.id, (id) => api.plugin<Tunnel>("wireguard", "POST", `/tunnels/${id}/restart`));

  const handleDelete = async (tunnel: Tunnel) => {
    if (!window.confirm(t("confirm.delete", { id: tunnel.id }))) return;
    try {
      await api.plugin<void>("wireguard", "DELETE", `/tunnels/${tunnel.id}`);
      await poll();
    } catch (err: unknown) {
      setApiError(errorText(err));
    }
  };

  const handleEdit = (t: Tunnel) => {
    setEditing(t);
    setDialogOpen(true);
  };

  const handleOpenAdd = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    setEditing(null);
    setWarnings([]);
  };

  const handleDialogWarnings = (w: string[]) => {
    setWarnings(w);
    // Keep dialog open — user must close it manually
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <h1 className="text-sm font-medium truncate">VPN · WireGuard</h1>
        <span className="text-xs text-muted-foreground">
          {t("summary", { up: upCount, total: tunnels.length })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex h-7 items-center gap-2 rounded-lg border border-input bg-transparent px-2 text-sm focus-within:ring-2 focus-within:ring-ring">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              placeholder={t("search.placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <Button size="sm" onClick={handleOpenAdd}>
            <Plus className="size-3.5" />
            {t("addTunnel")}
          </Button>
        </div>
      </header>

      {/* Warning when WireGuard is unavailable */}
      {available === false && (
        <div className="mx-3 mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-medium">{t("unavailable.title")}</p>
          <p className="mt-1 opacity-90">
            {apiError || t("unavailable.hint")}
          </p>
        </div>
      )}

      {/* General API error (non-502) */}
      {available && apiError && (
        <p className="mx-3 mt-2 text-xs text-destructive">{apiError}</p>
      )}

      {/* Filter chips */}
      <div className="flex gap-1 px-4 py-1">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="xs"
            variant={filter === f.key ? "default" : "ghost"}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {/* Tunnel list */}
      <div className="flex-1 overflow-y-auto">
        {available === null ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="ml-2">{t("loading")}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            {t("list.empty")}
          </div>
        ) : (
          filtered.map((t) => (
            <TunnelRow
              key={t.id}
              tunnel={t}
              expanded={expandedId === t.id}
              onExpand={() =>
                setExpandedId((prev) => (prev === t.id ? null : t.id))
              }
              onUp={handleUp}
              onDown={handleDown}
              onRestart={handleRestart}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>

      {/* Create / Edit dialog */}
      <TunnelDialog
        open={dialogOpen}
        tunnel={editing}
        onClose={handleCloseDialog}
        onWarnings={handleDialogWarnings}
      />

      {/* Warnings banner (kept open when dialog has warnings) */}
      {warnings.length > 0 && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <span className="font-medium shrink-0">{t("warnings.title")}</span>
            <ul className="list-disc pl-4 flex-1">
              {warnings.map((w, i) => (
                <li key={i}>{serverMsg(w)}</li>
              ))}
            </ul>
            <Button
              size="xs"
              variant="ghost"
              className="shrink-0"
              onClick={() => setWarnings([])}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}