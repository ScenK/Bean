// packages/core/src/cron.ts
/** Minimal 5-field cron (minute hour day-of-month month day-of-week), local time.
 * Supports `*`, lists (`1,5`), ranges (`1-5`), and steps (`*` with `/N`, or `a-b/N`).
 * No names, no seconds, no `L/W/#`. Day-of-month and day-of-week combine with OR only
 * when both are restricted (standard cron semantics). */
export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;      // 1-31
  months: Set<number>;    // 1-12
  weekdays: Set<number>;  // 0-6, 0 = Sunday
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

const FIELDS: { min: number; max: number }[] = [
  { min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 }, { min: 1, max: 12 }, { min: 0, max: 7 },
];

function parseField(raw: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const [rangeRaw, stepRaw] = part.split("/") as [string, string?];
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step: ${part}`);
    let lo: number;
    let hi: number;
    if (rangeRaw === "*") {
      lo = min; hi = max;
    } else if (rangeRaw.includes("-")) {
      const [a, b] = rangeRaw.split("-").map(Number);
      if (a === undefined || b === undefined || !Number.isInteger(a) || !Number.isInteger(b)) {
        throw new Error(`bad cron range: ${part}`);
      }
      lo = a; hi = b;
    } else {
      const n = Number(rangeRaw);
      if (!Number.isInteger(n)) throw new Error(`bad cron value: ${part}`);
      lo = n; hi = n;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron value out of range: ${part}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`empty cron field: ${raw}`);
  return out;
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields, got ${parts.length}: "${expr}"`);
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]!.min, FIELDS[i]!.max));
  const weekdays = new Set([...sets[4]!].map((v) => (v === 7 ? 0 : v))); // 7 = Sunday alias
  return {
    minutes: sets[0]!, hours: sets[1]!, days: sets[2]!, months: sets[3]!, weekdays,
    dayRestricted: parts[2] !== "*",
    weekdayRestricted: parts[4] !== "*",
  };
}

export function isValidCron(expr: string): boolean {
  try { parseCron(expr); return true; } catch { return false; }
}

function matches(spec: CronSpec, t: Date): boolean {
  if (!spec.minutes.has(t.getMinutes()) || !spec.hours.has(t.getHours()) || !spec.months.has(t.getMonth() + 1)) {
    return false;
  }
  const dayOk = spec.days.has(t.getDate());
  const weekdayOk = spec.weekdays.has(t.getDay());
  // Standard cron: both restricted → OR; otherwise both must match (an unrestricted field always does).
  if (spec.dayRestricted && spec.weekdayRestricted) return dayOk || weekdayOk;
  return dayOk && weekdayOk;
}

/** First matching minute strictly after `from`, local time. Scans minute-by-minute —
 * bounded at 366 days, plenty for any 5-field expression with a match. */
export function nextRun(expr: string, from: Date): Date {
  const spec = parseCron(expr);
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    t.setMinutes(t.getMinutes() + 1);
    if (matches(spec, t)) return new Date(t.getTime());
  }
  throw new Error(`cron never matches within a year: "${expr}"`);
}
