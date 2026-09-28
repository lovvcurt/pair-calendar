export type Visibility = 'full' | 'busy' | 'private';
export type Reminder = { minutes: number };
export type EventDetails = {
  title: string; description: string; place: string; address: string;
  latitude: number | null; longitude: number | null; category: string;
  tags: string[]; color: string; reminders: Reminder[];
};
export type CalendarEvent = {
  id: string; couple_id: string; owner_id: string; starts_at: string; ends_at: string;
  all_day: boolean; timezone: string; visibility: Visibility; surprise_until: string | null;
  recurrence_frequency: 'daily' | 'weekly' | 'monthly' | 'yearly' | null;
  recurrence_interval: number; recurrence_until: string | null; created_at: string; updated_at: string;
  details: EventDetails | null; ownerName: string; isOccurrence?: boolean; occurrenceStart?: string; originalStartsAt?: string; originalEndsAt?: string;
};

export const blankDetails = (): EventDetails => ({
  title: '', description: '', place: '', address: '', latitude: null, longitude: null,
  category: 'Другое', tags: [], color: '#a6e3b0', reminders: [],
});

export function toLocalInput(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}
export function fromLocalInput(value: string): string { return new Date(value).toISOString(); }
export function todayInput(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function dateInput(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function localMidnight(date: Date): Date { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
export function addDays(date: Date, days: number): Date { const result = new Date(date); result.setDate(result.getDate() + days); return result; }
export function monthStart(date: Date): Date { return new Date(date.getFullYear(), date.getMonth(), 1); }
export function weekStart(date: Date): Date { const result = localMidnight(date); result.setDate(result.getDate() - ((result.getDay() + 6) % 7)); return result; }
export function sameDay(a: Date, b: Date): boolean { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
export function initials(name: string): string {
  const bits = name.trim().split(/[\s@._-]+/).filter(Boolean);
  return bits.slice(0, 2).map((part) => Array.from(part)[0]?.toLocaleUpperCase('ru') ?? '').join('') || '♥';
}
export function formatTime(value: string): string { return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
export function formatDate(value: Date | string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' }): string {
  const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = value instanceof Date ? value : dateOnly ? new Date(+value.slice(0, 4), +value.slice(5, 7) - 1, +value.slice(8, 10)) : new Date(value);
  return new Intl.DateTimeFormat('ru-RU', options).format(date);
}
export function timezoneName(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
type WallTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };
function wallTime(date: Date, timezone: string): WallTime {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}
export function dateTimeInZone(wall: WallTime, timezone: string): Date {
  // Translate local wall-clock components in an IANA zone to an absolute instant.
  const wanted = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  let candidate = wanted;
  for (let i = 0; i < 4; i++) {
    const actual = wallTime(new Date(candidate), timezone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate += wanted - represented;
  }
  return new Date(candidate);
}

function addCalendarUnit(wall: WallTime, frequency: NonNullable<CalendarEvent['recurrence_frequency']>, interval: number, anchorDay = wall.day): WallTime {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second));
  if (frequency === 'daily') date.setUTCDate(date.getUTCDate() + interval);
  if (frequency === 'weekly') date.setUTCDate(date.getUTCDate() + interval * 7);
  if (frequency === 'monthly') {
    const targetMonth = date.getUTCMonth() + interval;
    const targetYear = date.getUTCFullYear() + Math.floor(targetMonth / 12);
    const month = targetMonth % 12;
    const day = Math.min(anchorDay, new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate());
    date.setUTCFullYear(targetYear, month, day);
  }
  if (frequency === 'yearly') {
    const year = date.getUTCFullYear() + interval;
    const day = Math.min(anchorDay, new Date(Date.UTC(year, date.getUTCMonth() + 1, 0)).getUTCDate());
    date.setUTCFullYear(year, date.getUTCMonth(), day);
  }
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}

export function occurrences(event: CalendarEvent, from: Date, to: Date): CalendarEvent[] {
  const start = new Date(event.starts_at);
  const duration = new Date(event.ends_at).getTime() - start.getTime();
  if (!event.recurrence_frequency) return new Date(event.ends_at) >= from && start <= to ? [event] : [];
  const output: CalendarEvent[] = [];
  const timezone = event.timezone || 'UTC';
  const startWall = wallTime(start, timezone);
  const endWall = wallTime(new Date(event.ends_at), timezone);
  const allDaySpan = Math.max(1, Math.round((Date.UTC(endWall.year, endWall.month - 1, endWall.day) - Date.UTC(startWall.year, startWall.month - 1, startWall.day)) / 86_400_000));
  const untilDate = event.recurrence_until;
  const fromWall = wallTime(from, timezone);
  const dayDelta = Math.floor((Date.UTC(fromWall.year, fromWall.month - 1, fromWall.day) - Date.UTC(startWall.year, startWall.month - 1, startWall.day)) / 86_400_000);
  const monthDelta = (fromWall.year - startWall.year) * 12 + fromWall.month - startWall.month;
  const interval = event.recurrence_interval || 1;
  const rawSteps = event.recurrence_frequency === 'daily' ? Math.floor(dayDelta / interval)
    : event.recurrence_frequency === 'weekly' ? Math.floor(dayDelta / (7 * interval))
      : event.recurrence_frequency === 'monthly' ? Math.floor(monthDelta / interval)
        : Math.floor((fromWall.year - startWall.year) / interval);
  let count = Math.max(0, rawSteps - 1);
  let cursorWall = count ? addCalendarUnit(startWall, event.recurrence_frequency, count * interval, startWall.day) : startWall;
  let cursor = count ? dateTimeInZone(cursorWall, timezone) : start;
  let iterations = 0;
  while (cursor <= to && (!untilDate || `${cursorWall.year}-${String(cursorWall.month).padStart(2, '0')}-${String(cursorWall.day).padStart(2, '0')}` <= untilDate) && iterations < 500) {
    let end: Date;
    if (event.all_day) {
      const endWall = addCalendarUnit({ ...cursorWall, day: cursorWall.day + allDaySpan - 1 }, 'daily', 1);
      end = dateTimeInZone({ ...endWall, hour: 0, minute: 0, second: 0 }, timezone);
    } else end = new Date(cursor.getTime() + duration);
    if (end >= from) output.push({ ...event, isOccurrence: count > 0, occurrenceStart: cursor.toISOString(), originalStartsAt: event.starts_at, originalEndsAt: event.ends_at, starts_at: cursor.toISOString(), ends_at: end.toISOString() });
    cursorWall = addCalendarUnit(cursorWall, event.recurrence_frequency, interval, startWall.day);
    cursor = dateTimeInZone(cursorWall, timezone);
    count++;
    iterations++;
  }
  return output;
}
