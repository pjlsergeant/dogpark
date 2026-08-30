/** Small formatters. Timestamps are ISO-8601 from the server (`Timestamp`). */

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const ABSOLUTE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const TIME_ONLY = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['second', 1000],
  ['minute', 60_000],
  ['hour', 3_600_000],
  ['day', 86_400_000],
  ['week', 604_800_000],
  ['month', 2_629_800_000],
  ['year', 31_557_600_000],
];

export function relativeTime(iso: string, from: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const delta = at - from;
  const magnitude = Math.abs(delta);
  let chosen: readonly [Intl.RelativeTimeFormatUnit, number] = UNITS[0] ?? ['second', 1000];
  for (const unit of UNITS) {
    if (magnitude >= unit[1]) chosen = unit;
  }
  return RELATIVE.format(Math.round(delta / chosen[1]), chosen[0]);
}

export function absoluteTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : ABSOLUTE.format(at);
}

export function clockTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : TIME_ONLY.format(at);
}

export function dayHeading(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : DAY.format(at);
}

export function sameDay(a: string, b: string): boolean {
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index] ?? 'B'}`;
}

/** An idempotency key: one per draft, so a retry of it cannot double-post. */
export function idempotencyKey(): string {
  return crypto.randomUUID();
}
