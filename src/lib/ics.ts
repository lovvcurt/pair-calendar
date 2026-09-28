import type { CalendarEvent, EventDetails } from './calendar';
import { dateInput, dateTimeInZone, fromLocalInput, occurrences, timezoneName } from './calendar';

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}
function unfold(text: string): string[] { return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/); }
function parseIcsDate(raw: string, valueType?: string, tzid?: string): { iso: string; allDay: boolean } {
  if (valueType === 'DATE' || /^\d{8}$/.test(raw)) {
    const year = Number(raw.slice(0, 4)); const month = Number(raw.slice(4, 6)) - 1; const day = Number(raw.slice(6, 8));
    return { iso: new Date(year, month, day).toISOString(), allDay: true };
  }
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!match) {
    const parsed = new Date(raw);
    if (!Number.isFinite(parsed.getTime())) throw new Error(`Не удалось прочитать дату «${raw}»`);
    return { iso: parsed.toISOString(), allDay: false };
  }
  const [, y, m, d, hh, mm, ss = '00', z] = match;
  if (z) return { iso: new Date(Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss)).toISOString(), allDay: false };
  if (tzid) return { iso: dateTimeInZone({ year: +y, month: +m, day: +d, hour: +hh, minute: +mm, second: +ss }, tzid).toISOString(), allDay: false };
  return { iso: fromLocalInput(`${y}-${m}-${d}T${hh}:${mm}`), allDay: false };
}
export type ImportedEvent = { details: EventDetails; starts_at: string; ends_at: string; all_day: boolean; timezone: string; recurrence_frequency: CalendarEvent['recurrence_frequency']; recurrence_interval: number; recurrence_until: string | null; unsupportedRecurrence: boolean };
export function parseCalendar(text: string): ImportedEvent[] {
  const lines = unfold(text.replace(/^\uFEFF/, ''));
  const components: string[][] = []; let current: string[] | null = null;
  for (const line of lines) {
    if (line.trim() === 'BEGIN:VEVENT') current = [];
    else if (line.trim() === 'END:VEVENT' && current) { components.push(current); current = null; }
    else if (current && line.includes(':')) current.push(line);
  }
  return components.map((component) => {
    const props = new Map<string, { value: string; params: string }[]>();
    for (const line of component) {
      const index = line.indexOf(':'); const left = line.slice(0, index); const value = line.slice(index + 1);
      const [name, ...params] = left.split(';'); const key = name.toUpperCase();
      props.set(key, [...(props.get(key) ?? []), { value, params: params.join(';') }]);
    }
    const get = (key: string) => props.get(key)?.[0];
    const startProperty = get('DTSTART'); if (!startProperty) throw new Error('В одном из событий нет DTSTART.');
    const startZone = startProperty.params.match(/TZID="?([^";]+)"?/i)?.[1];
    const timezone = /^\d{8}$/.test(startProperty.value) || /VALUE=DATE/i.test(startProperty.params) ? timezoneName() : startZone ?? timezoneName();
    const starts = parseIcsDate(startProperty.value, /VALUE=DATE/i.test(startProperty.params) ? 'DATE' : undefined, startZone);
    const endProperty = get('DTEND');
    const endZone = endProperty?.params.match(/TZID="?([^";]+)"?/i)?.[1];
    const ends = endProperty ? parseIcsDate(endProperty.value, /VALUE=DATE/i.test(endProperty.params) ? 'DATE' : undefined, endZone) : { iso: new Date(new Date(starts.iso).getTime() + (starts.allDay ? 86400000 : 3600000)).toISOString(), allDay: starts.allDay };
    const unescape = (v: string) => v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
    const rrule = get('RRULE')?.value ?? '';
    const values = Object.fromEntries(rrule.split(';').map((part) => { const [k, v] = part.split('='); return [k, v]; }));
    const freqMap: Record<string, NonNullable<CalendarEvent['recurrence_frequency']>> = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' };
    const until = values.UNTIL ? parseIcsDate(values.UNTIL).iso.slice(0, 10) : null;
    const unsupportedRecurrence = Boolean((rrule && (values.COUNT || Object.keys(values).some((key) => key.startsWith('BY')))) || props.has('EXDATE') || props.has('RDATE'));
    return {
      starts_at: starts.iso, ends_at: ends.iso, all_day: starts.allDay, timezone,
      recurrence_frequency: unsupportedRecurrence ? null : freqMap[values.FREQ] ?? null, recurrence_interval: Math.max(1, Number(values.INTERVAL) || 1), recurrence_until: unsupportedRecurrence ? null : until, unsupportedRecurrence,
      details: { title: unescape(get('SUMMARY')?.value ?? 'Событие'), description: unescape(get('DESCRIPTION')?.value ?? ''), place: unescape(get('LOCATION')?.value ?? ''), address: '', latitude: null, longitude: null, category: 'Импорт', tags: [], color: '#a6e3b0', reminders: [] },
    };
  });
}
function foldedLine(line: string): string {
  const chunks: string[] = []; let rest = line;
  while (new TextEncoder().encode(rest).length > 73) {
    let cut = Math.min(73, rest.length);
    while (new TextEncoder().encode(rest.slice(0, cut)).length > 73) cut--;
    chunks.push(rest.slice(0, cut)); rest = ` ${rest.slice(cut)}`;
  }
  chunks.push(rest); return chunks.join('\r\n');
}
function utcStamp(value: string): string { return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
export function exportCalendar(events: CalendarEvent[], from: Date, to: Date): string {
  const rows = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vmeste//Pair Calendar//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  const materialized = events.flatMap((event) => occurrences(event, from, to));
  for (const event of materialized) {
    const details = event.details;
    rows.push('BEGIN:VEVENT', `UID:${event.id}-${event.starts_at}@vmeste.app`, `DTSTAMP:${utcStamp(new Date().toISOString())}`);
    if (event.all_day) {
      rows.push(`DTSTART;VALUE=DATE:${dateInput(event.starts_at).replace(/-/g, '')}`);
      rows.push(`DTEND;VALUE=DATE:${dateInput(event.ends_at).replace(/-/g, '')}`);
    } else {
      rows.push(`DTSTART:${utcStamp(event.starts_at)}`, `DTEND:${utcStamp(event.ends_at)}`);
    }
    rows.push(`SUMMARY:${escapeText(details?.title ?? (event.visibility === 'busy' ? 'Занято' : 'Сюрприз'))}`);
    if (details?.description) rows.push(`DESCRIPTION:${escapeText(details.description)}`);
    if (details?.place || details?.address) rows.push(`LOCATION:${escapeText([details.place, details.address].filter(Boolean).join(', '))}`);
    rows.push('END:VEVENT');
  }
  rows.push('END:VCALENDAR');
  return rows.map(foldedLine).join('\r\n');
}
