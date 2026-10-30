// Types for the WireGuard plugin API contract.
import { t } from "./i18n";

export interface TunnelPeer {
  publicKey: string;
  endpoint: string | null;
  allowedIPs: string[];
  latestHandshake: number; // epoch sec, 0 = never
  rx: number;
  tx: number;
}

export interface Tunnel {
  id: string;
  label: string;
  autostart: boolean;
  desired: "up" | "down";
  lastError: string | null;
  state: "up" | "down";
  health: "connected" | "stale" | "no-handshake" | "down";
  publicKey: string;
  address: string[];
  peers: TunnelPeer[];
}

export interface TunnelListResponse {
  available: boolean;
  error?: string;
  tunnels: Tunnel[];
}

export interface TunnelSaveResult {
  id: string;
  warnings: string[];
}

export interface KeyGenResult {
  privateKey: string;
  publicKey: string;
}

export interface TunnelDetail extends Tunnel {
  config: string;
}

export type FilterKey = "all" | "connected" | "problems" | "down";

export const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: t("filter.all") },
  { key: "connected", label: t("filter.connected") },
  { key: "problems", label: t("filter.problems") },
  { key: "down", label: t("filter.down") },
];

// Matches the interface name pattern for WireGuard interfaces.
export const ID_PATTERN = /^[a-zA-Z0-9_=+.-]{1,15}$/;