// Contract of /api/plugins/scheduler (server: plugins/scheduler/server).

// Wall-clock schedules carry the browser's IANA time zone, so "03:00" means 03:00 where the admin is.
export type Schedule =
  | { kind: "once"; at: number } // epoch ms
  | { kind: "daily"; time: string; tz: string } // time "HH:MM"
  | { kind: "weekly"; time: string; days: number[]; tz: string } // days 0=Sun … 6=Sat, at least one
  | { kind: "monthly"; time: string; day: number; tz: string }; // day 1…28

export interface JobInput {
  nodeId: string;
  title: string;
  prompt: string;
  agent: string | null; // null = default agent
  model: { providerID: string; modelID: string } | null; // null = agent's model
  schedule: Schedule;
  // Turns the node's autopilot on (4 h) when the run starts: night jobs do not stall on approvals; dangerous commands still ask.
  autopilot: boolean;
}

export interface Job extends JobInput {
  id: string;
  enabled: boolean;
  nextRunAt: number | null; // null when a one-off already ran or the job is paused
  lastRunAt: number | null;
  lastTaskId: string | null;
  lastError: string | null;
  createdAt: number;
}

export interface Run {
  ts: number;
  taskId: string | null;
  error: string | null;
}

// GET    /jobs?nodeId=<id>     → Job[] (all jobs without nodeId), sorted by nextRunAt
// POST   /jobs                 JobInput → Job (201); 400 { error } on bad input
// PUT    /jobs/:id             Partial<JobInput> & { enabled?: boolean } → Job
// DELETE /jobs/:id             → { ok: true }
// POST   /jobs/:id/run         → { taskId } — run now, schedule unchanged; 409 { error } if the previous run is still working
// GET    /jobs/:id/runs        → Run[] newest first (last 50)
