// Next run time for a schedule. Wall-clock schedules are evaluated in their own IANA zone, DST included.
import type { Schedule } from "../web/types";

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function zoneParts(ts: number, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const p = Object.fromEntries(fmt.formatToParts(ts).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute, s: p.second };
}

// Zone offset in ms at an instant (local wall clock minus UTC).
function offset(ts: number, tz: string): number {
  const p = zoneParts(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ts / 1000) * 1000;
}

// Instant of a wall-clock time in a zone; a time skipped by a DST jump lands just after the jump.
export function wallToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - offset(guess, tz);
  return guess - offset(first, tz);
}

export function validTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Returns a Russian error or null.
export function checkSchedule(s: unknown, now: number): string | null {
  if (typeof s !== "object" || s === null) return "нужно расписание";
  const v = s as Record<string, unknown>;
  if (v.kind === "once") return typeof v.at === "number" && v.at > now ? null : "время запуска должно быть в будущем";
  if (v.kind !== "daily" && v.kind !== "weekly" && v.kind !== "monthly") return "неизвестный вид расписания";
  if (typeof v.time !== "string" || !TIME.test(v.time)) return "время в формате ЧЧ:ММ";
  if (!validTz(v.tz)) return "неизвестный часовой пояс";
  if (v.kind === "weekly") {
    const days = v.days;
    if (!Array.isArray(days) || days.length === 0 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return "выберите дни недели";
  }
  if (v.kind === "monthly" && !(Number.isInteger(v.day) && (v.day as number) >= 1 && (v.day as number) <= 28)) return "день месяца от 1 до 28";
  return null;
}

// First run strictly after `after`, or null when a one-off is in the past.
export function nextRun(s: Schedule, after: number): number | null {
  if (s.kind === "once") return s.at > after ? s.at : null;
  const [h, min] = s.time.split(":").map(Number);
  const today = zoneParts(after, s.tz);
  // Calendar day `i` days from today in the schedule's zone.
  const day = (i: number) => {
    const t = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
  };
  if (s.kind === "monthly") {
    for (let i = 0; i < 3; i++) {
      const t = new Date(Date.UTC(today.y, today.m - 1 + i, 1));
      const at = wallToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, s.day, h, min, s.tz);
      if (at > after) return at;
    }
    return null;
  }
  for (let i = 0; i <= 7; i++) {
    const c = day(i);
    if (s.kind === "weekly" && !s.days.includes(c.wd)) continue;
    const at = wallToUtc(c.y, c.m, c.d, h, min, s.tz);
    if (at > after) return at;
  }
  return null;
}
