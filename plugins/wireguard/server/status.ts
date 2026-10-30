// Parses `wg show all dump`: an interface line has 5 tab-separated fields, a peer line 9.
export interface PeerStatus {
  publicKey: string;
  endpoint: string | null;
  allowedIPs: string[];
  latestHandshake: number;
  rx: number;
  tx: number;
}

export function parseDump(text: string): Map<string, PeerStatus[]> {
  const ifaces = new Map<string, PeerStatus[]>();
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    if (f.length === 5) ifaces.set(f[0], ifaces.get(f[0]) ?? []);
    else if (f.length === 9) {
      const peers = ifaces.get(f[0]) ?? [];
      peers.push({
        publicKey: f[1],
        endpoint: f[3] === "(none)" ? null : f[3],
        allowedIPs: f[4] === "(none)" ? [] : f[4].split(","),
        latestHandshake: Number(f[5]) || 0,
        rx: Number(f[6]) || 0,
        tx: Number(f[7]) || 0,
      });
      ifaces.set(f[0], peers);
    }
  }
  return ifaces;
}

// A handshake renews every 2 minutes while traffic flows; 3 minutes without one means the peer is gone.
export const STALE_SEC = 180;

export function health(peers: PeerStatus[] | undefined, nowSec: number): "connected" | "stale" | "no-handshake" | "down" {
  if (!peers) return "down";
  const last = Math.max(0, ...peers.map((p) => p.latestHandshake));
  if (last === 0) return "no-handshake";
  return nowSec - last <= STALE_SEC ? "connected" : "stale";
}
