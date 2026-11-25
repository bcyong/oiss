/**
 * Store-local time. The simulator counts seconds since local midnight on the
 * simulated date; records carry RFC 3339 timestamps with the store's offset.
 */

export interface StoreClock {
  /** Calendar date, YYYY-MM-DD. */
  date: string;
  timezone: string;
  /** UTC offset on that date, such as "-08:00". */
  offset: string;
  /** Seconds since local midnight -> RFC 3339 with offset. */
  iso(seconds: number): string;
  /** Seconds since local midnight -> epoch milliseconds. */
  epochMs(seconds: number): number;
}

/** The zone's UTC offset at local noon on the date (DST changes overnight, so noon is safe for a store day). */
export function utcOffset(date: string, timezone: string): string {
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(noonUtc);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  if (name === "GMT") return "+00:00";
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  if (!m) throw new Error(`can't read the UTC offset for ${timezone}: ${name}`);
  return `${m[1]}${m[2]!.padStart(2, "0")}:${m[3] ?? "00"}`;
}

export function storeClock(date: string, timezone: string): StoreClock {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must be YYYY-MM-DD: ${date}`);
  const offset = utcOffset(date, timezone);
  const sign = offset.startsWith("-") ? -1 : 1;
  const offsetMinutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const midnightUtcMs = Date.parse(`${date}T00:00:00Z`) - offsetMinutes * 60_000;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date,
    timezone,
    offset,
    iso(seconds: number): string {
      const s = Math.round(seconds);
      if (s < 0 || s >= 86_400) throw new Error(`time outside the store day: ${seconds}`);
      return `${date}T${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}${offset}`;
    },
    epochMs(seconds: number): number {
      return midnightUtcMs + seconds * 1000;
    },
  };
}

export const hours = (h: number, m = 0, s = 0): number => h * 3600 + m * 60 + s;

/** "HH:MM" for display. */
export function clockLabel(seconds: number): string {
  const s = Math.floor(seconds);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}
