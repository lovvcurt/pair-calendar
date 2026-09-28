import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function loadTypeScript(entryPoint) {
  const result = await build({ entryPoints: [entryPoint], bundle: true, format: 'esm', platform: 'node', write: false });
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64');
  return import(`data:text/javascript;base64,${source}`);
}

const calendar = await loadTypeScript('./src/lib/calendar.ts');
const ics = await loadTypeScript('./src/lib/ics.ts');

test('monthly recurrence keeps its local wall time over a DST change and clamps month-end dates', () => {
  const event = {
    id: 'monthly', couple_id: 'pair', owner_id: 'owner', starts_at: '2026-01-31T17:30:00.000Z', ends_at: '2026-01-31T18:30:00.000Z',
    all_day: false, timezone: 'Europe/Warsaw', visibility: 'full', surprise_until: null,
    recurrence_frequency: 'monthly', recurrence_interval: 1, recurrence_until: '2026-04-30',
    created_at: '', updated_at: '', details: null, ownerName: 'Тест',
  };
  const result = calendar.occurrences(event, new Date('2026-01-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'));
  assert.deepEqual(result.map((item) => item.starts_at), [
    '2026-01-31T17:30:00.000Z', '2026-02-28T17:30:00.000Z',
    '2026-03-31T16:30:00.000Z', '2026-04-30T16:30:00.000Z',
  ]);
});

test('all-day events preserve local midnight across a 23-hour DST day', () => {
  const event = {
    id: 'all-day', couple_id: 'pair', owner_id: 'owner', starts_at: '2026-03-28T23:00:00.000Z', ends_at: '2026-03-29T22:00:00.000Z',
    all_day: true, timezone: 'Europe/Warsaw', visibility: 'full', surprise_until: null,
    recurrence_frequency: 'daily', recurrence_interval: 1, recurrence_until: '2026-03-31',
    created_at: '', updated_at: '', details: null, ownerName: 'Тест',
  };
  const result = calendar.occurrences(event, new Date('2026-03-28T00:00:00Z'), new Date('2026-04-01T00:00:00Z'));
  assert.deepEqual(result.map((item) => [item.starts_at, item.ends_at]), [
    ['2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z'],
    ['2026-03-29T22:00:00.000Z', '2026-03-30T22:00:00.000Z'],
    ['2026-03-30T22:00:00.000Z', '2026-03-31T22:00:00.000Z'],
  ]);
});

test('ICS import reads TZID and basic recurrence, while unsupported rules stay a single event', () => {
  const recurring = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:weekly-1\r\nDTSTART;TZID=Europe/Warsaw:20261020T183000\r\nDTEND;TZID=Europe/Warsaw:20261020T193000\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261118T173000Z\r\nSUMMARY:Ужин\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const [event] = ics.parseCalendar(recurring);
  assert.equal(event.timezone, 'Europe/Warsaw');
  assert.equal(event.starts_at, '2026-10-20T16:30:00.000Z');
  assert.equal(event.recurrence_frequency, 'weekly');
  assert.equal(event.recurrence_interval, 2);
  assert.equal(event.recurrence_until, '2026-11-18');
  assert.equal(event.unsupportedRecurrence, false);

  const complex = recurring.replace('FREQ=WEEKLY;INTERVAL=2;UNTIL=20261118T173000Z', 'FREQ=WEEKLY;COUNT=3;BYDAY=TU,TH');
  const [single] = ics.parseCalendar(complex);
  assert.equal(single.recurrence_frequency, null);
  assert.equal(single.unsupportedRecurrence, true);
});

test('ICS export materializes recurring events within the requested range', () => {
  const event = {
    id: 'monthly', couple_id: 'pair', owner_id: 'owner', starts_at: '2026-01-31T17:30:00.000Z', ends_at: '2026-01-31T18:30:00.000Z',
    all_day: false, timezone: 'Europe/Warsaw', visibility: 'full', surprise_until: null,
    recurrence_frequency: 'monthly', recurrence_interval: 1, recurrence_until: '2026-03-31',
    created_at: '', updated_at: '', details: { title: 'Ужин', description: '', place: '', address: '', latitude: null, longitude: null, category: 'Свидание', tags: [], color: '#a6e3b0', reminders: [] }, ownerName: 'Тест',
  };
  const output = ics.exportCalendar([event], new Date('2026-01-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z'));
  assert.equal((output.match(/BEGIN:VEVENT/g) ?? []).length, 3);
  assert.equal((output.match(/SUMMARY:Ужин/g) ?? []).length, 3);
  assert.equal(ics.parseCalendar(output).length, 3);
});
