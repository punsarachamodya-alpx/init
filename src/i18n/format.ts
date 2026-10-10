import type { Locale } from './index.ts';

/** Display time zone. Everything is stored in UTC; only the display converts. */
export const DISPLAY_TZ = 'Asia/Colombo';

const TAG: Record<Locale, string> = { en: 'en-GB', si: 'si-LK', ta: 'ta-LK' };

/** "14 Oct 2026, 08:30" style date and time in Colombo time, in the user's language. */
export function formatColombo(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(TAG[locale], { timeZone: DISPLAY_TZ, dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(date);
}

/** Date only, in Colombo time. */
export function formatColomboDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(TAG[locale], { timeZone: DISPLAY_TZ, dateStyle: 'medium' }).format(date);
}

/**
 * A duration as its two largest non-zero units, e.g. "2 d 4 h" (units localised by Intl); under a minute is "0 min".
 * Negative durations (clock skew, an event dated ahead) are shown as zero.
 */
export function formatAge(ms: number, locale: Locale): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const unit = (value: number, u: 'day' | 'hour' | 'minute') =>
    new Intl.NumberFormat(TAG[locale], { style: 'unit', unit: u, unitDisplay: 'short' }).format(value);
  const parts: string[] = [];
  if (days > 0) parts.push(unit(days, 'day'));
  if (hours > 0 && parts.length < 2) parts.push(unit(hours, 'hour'));
  if (minutes > 0 && parts.length < 2 && days === 0) parts.push(unit(minutes, 'minute'));
  return parts.length > 0 ? parts.join(' ') : unit(0, 'minute');
}

/** "YYYY-MM-DDTHH:mm" in Colombo time, the value format of <input type="datetime-local">. */
export function toColomboInput(date: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Parse a Colombo-time "YYYY-MM-DDTHH:mm" input into the UTC instant it names. Sri Lanka has no daylight saving (+05:30). Null if not a real date and time. */
export function fromColomboInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(`${value.trim()}:00+05:30`);
  if (Number.isNaN(d.getTime())) return null;
  return toColomboInput(d) === value.trim() ? d : null; // rejects 31 Feb and the like (the Date would roll over)
}
