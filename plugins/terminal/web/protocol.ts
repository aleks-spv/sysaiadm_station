// WebSocket protocol of the terminal plugin (server: plugins/terminal/server).
//
// URL: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/plugins/terminal/ws/<nodeId>?cols=<n>&rows=<n>`
// Auth is the admin session cookie; the server checks Origin.
//
// server → client:
//   binary frame          raw terminal output bytes (UTF-8 stream, may split characters: feed into xterm.write(Uint8Array))
//   text frame, JSON      ServerMessage
// client → server: text frames, JSON ClientMessage

export type ServerMessage =
  | { type: "ready"; node: string; via: string[] } // shell is open; via = bastions on the route
  | { type: "error"; message: string } // connection failed or dropped; the socket closes after it
  | { type: "exit"; code: number | null }; // remote shell exited; the socket closes after it

export type ClientMessage = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };

export function terminalUrl(nodeId: string, cols: number, rows: number): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/api/plugins/terminal/ws/${encodeURIComponent(nodeId)}?cols=${cols}&rows=${rows}`;
}
