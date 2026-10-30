// Contract between the rtk plugin server (/api/plugins/rtk) and its page. Bytes, not tokens: tokens ≈ bytes / 4.

export interface RtkTotals {
  commands: number;
  // Commands whose output got smaller.
  compressed: number;
  bytesIn: number;
  bytesOut: number;
}

export interface RtkDay extends RtkTotals {
  day: string; // YYYY-MM-DD, UTC
}

export interface RtkMethod extends RtkTotals {
  // "rtk:<filter>" when the rtk binary filtered it, "compact" for the built-in compaction.
  method: string;
}

export interface RtkRun {
  id: number;
  ts: number;
  nodeId: string;
  taskId: string;
  command: string;
  method: string;
  bytesIn: number;
  bytesOut: number;
}

export interface RtkStats {
  // Path and `rtk --version` of the binary, or null when it is not installed: then only the built-in compaction works.
  binary: { path: string; version: string } | null;
  total: RtkTotals;
  today: RtkTotals;
  daily: RtkDay[]; // last 30 days, oldest first, only days with commands
  methods: RtkMethod[];
  recent: RtkRun[]; // newest first, up to 50
}

export interface RtkVersion {
  // external: RTK_BIN points to a binary managed elsewhere, so no upgrades from here.
  mode: "managed" | "external";
  current: string | null;
  path: string | null;
  latest: string | null;
  updateAvailable: boolean;
  busy: boolean;
  error: string | null;
  checkedAt: number | null;
}

// Routes: GET /stats → RtkStats; DELETE /stats → { ok: true } (clears the counters);
// GET /version[?refresh=1] → RtkVersion (GitHub checked every 6 h); POST /upgrade → RtkVersion, installs the latest release.
