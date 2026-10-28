import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { buildToday, handle, itemsForDay, dayFor, partsIn, parseConfig, type Config, type Source } from '../src/today.ts';

const root = new URL('..', import.meta.url);
const config: Config = parseConfig(await readFile(new URL('fixtures/config.json', root), 'utf8'));
const load = (s: Source) => readFile(new URL(s.file!, root), 'utf8');
const TZ = 'America/New_York';
const inline = (ics: string, source: Partial<Source> = {}, extra: Partial<Config> = {}): Config & { load: (s: Source) => Promise<string> } =>
  ({ timezone: TZ, sources: [{ id: 'x', ...source }], ...extra, load: async () => ics });
const run = (cfg: Config & { load?: (s: Source) => Promise<string> }, nowIso: string, clock?: '12' | '24') => buildToday({ config: cfg, load: cfg.load, nowMs: at(nowIso), clock });
const at = (iso: string) => Date.parse(iso);
const local = (ms: number) => { const p = partsIn(ms, TZ); return `${p.h}:${String(p.mi).padStart(2, '0')}`; };

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log('ok  ', name); };

await test('Tuesday Oct 27 at 9:00 AM: the sample day before anything starts', async () => {
  const d = await buildToday({ config, load, nowMs: at('2026-10-27T09:00:00-04:00') });
  assert.equal(d.weekday, 'Tuesday');
  assert.equal(d.date, 'October 27');
  assert.equal(d.updated, '9:00 AM');
  assert.equal(d.phase, 'morning');
  assert.deepEqual(d.events.map((e) => e.title), ['Intro to Programming', 'Writing Workshop', 'Calculus Discussion']);
  assert.deepEqual(d.events.map((e) => e.state), ['next', 'later', 'later']);
  assert.equal(d.events[0].meta, '11:30 AM – 12:45 PM · Room 204');
  assert.equal(d.events[2].meta, '5:30 – 6:20 PM · Room 143');
  assert.ok(d.events.every((e) => e.lanes === 1));
  assert.equal(d.up_next?.kind, 'event');
  assert.equal(d.up_next?.title, 'Intro to Programming');
  assert.equal(d.up_next?.note, '');
  assert.equal(d.summary, '3 left · 3 due');
  assert.deepEqual(d.due.map((x) => [x.time, x.course, x.kind, x.passed]), [['2:00 PM', 'Writing Workshop', 'Reading', false], ['2:00 PM', 'Writing Workshop', 'Discussion', false], ['11:59 PM', 'Calculus', 'Problem Set 7', false]]);
  assert.deepEqual(d.due_groups.map((g) => [g.time, g.course, g.items.length]), [['2:00 PM', 'Writing Workshop', 2], ['11:59 PM', 'Calculus', 1]]);
  assert.deepEqual(d.gaps.map((g) => [g.label, g.state]), [['1 h 15 min free', 'next'], ['2 h 15 min free', 'next']]);
  assert.deepEqual(d.marks, [], 'due at the start of an event is attached to that event');
  assert.equal(d.events[1].due, 'Reading, Discussion');
  assert.deepEqual(d.window, { start: '11 AM', end: '7 PM' });
});

await test('The window fits the schedule and is the same all day', async () => {
  const windows: string[] = [];
  for (const t of ['06:00', '11:46', '15:00', '20:00', '23:30']) {
    const d = await buildToday({ config, load, nowMs: at(`2026-10-27T${t}:00-04:00`) });
    windows.push(`${d.window.start}–${d.window.end}`);
    assert.ok(d.now.y >= 0 && d.now.y <= 1);
  }
  assert.deepEqual([...new Set(windows)], ['11 AM–7 PM']);
  const early = await buildToday({ config, load, nowMs: at('2026-10-27T06:00:00-04:00') });
  assert.deepEqual([early.now.before, early.now.y], [true, 0]);
  const late = await buildToday({ config, load, nowMs: at('2026-10-27T23:30:00-04:00') });
  assert.deepEqual([late.now.after, late.now.y], [true, 1]);
});

await test('1:30 PM: due items at the next start are folded into the hero', async () => {
  const d = await buildToday({ config, load, nowMs: at('2026-10-27T13:30:00-04:00') });
  assert.equal(d.up_next?.title, 'Writing Workshop');
  assert.equal(d.up_next?.note, '2 due when it starts');
  assert.deepEqual(d.events.map((e) => e.state), ['past', 'next', 'later']);
});

await test('2:30 PM: class in progress, due items passed, nothing relative to now', async () => {
  const d = await buildToday({ config, load, nowMs: at('2026-10-27T14:30:00-04:00') });
  const w = d.events.find((e) => e.title === 'Writing Workshop')!;
  assert.equal(w.state, 'now');
  assert.equal(w.meta, 'until 3:15 PM · Room 112');
  assert.deepEqual(d.due.map((x) => x.passed), [true, true, false]);
  assert.equal(d.summary, '2 left · 1 due');
  assert.equal(d.up_next?.title, 'Calculus Discussion');
  assert.equal(d.phase, 'day');
  assert.ok(!/\d+ min left|"in \d/.test(JSON.stringify(d)));
});

await test('8 PM: classes over, the homework is the next deadline', async () => {
  const d = await buildToday({ config, load, nowMs: at('2026-10-27T20:00:00-04:00') });
  assert.deepEqual([d.up_next?.kind, d.up_next?.time, d.up_next?.title, d.up_next?.place], ['due', '11:59 PM', 'Problem Set 7: Related rates', 'Calculus']);
  assert.equal(d.summary, 'All done · 1 due');
  assert.equal(d.phase, 'day');
});

await test('Midnight: nothing left', async () => {
  const d = await buildToday({ config, load, nowMs: at('2026-10-27T23:59:30-04:00') });
  assert.equal(d.up_next, null);
  assert.equal(d.phase, 'done');
});

await test('Monday: classes from the MWF series, nothing from Tue/Thu', async () => {
  const d = await buildToday({ config, load, nowMs: at('2026-10-26T08:00:00-04:00') });
  assert.deepEqual(d.events.map((e) => e.title), ['Weekly review', 'Calculus Lecture']);
  assert.equal(d.events[0].tag, 'HOME');
  assert.equal(d.events[1].meta, '10:00 – 10:50 AM · Room 151');
});

await test('Saturday: empty day', async () => {
  const d = await buildToday({ config, load, nowMs: at('2026-10-31T11:00:00-04:00') });
  assert.equal(d.phase, 'empty');
  assert.equal(d.summary, 'Free day');
  assert.deepEqual(d.window, { start: '8 AM', end: '8 PM' });
});

await test('EXDATE skips the holiday', async () => {
  const d = await buildToday({ config, load, nowMs: at('2026-10-13T08:00:00-04:00') });
  assert.ok(!d.events.some((e) => e.title === 'Intro to Programming'));
  assert.ok(d.events.some((e) => e.title === 'Writing Workshop'));
});

await test('After DST ends (Nov 3) classes stay at 11:30 AM local', async () => {
  const d = await buildToday({ config, load, nowMs: at('2026-11-03T08:00:00-05:00') });
  assert.equal(d.events.find((e) => e.title === 'Intro to Programming')!.meta, '11:30 AM – 12:45 PM · Room 204');
});

await test('24-hour clock', async () => {
  const d = await buildToday({ config, load, nowMs: at('2026-10-27T13:30:00-04:00'), clock: '24' });
  assert.equal(d.now.label, '13:30');
  assert.equal(d.up_next?.time, '14:00');
  assert.deepEqual(d.window, { start: '11', end: '19' });
});

const EDGE = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:no-vtimezone
DTSTART;TZID=America/Los_Angeles:20260601T090000
DTEND;TZID=America/Los_Angeles:20260601T100000
RRULE:FREQ=DAILY
SUMMARY:LA standup
END:VEVENT
BEGIN:VEVENT
UID:no-vtimezone
RECURRENCE-ID;TZID=America/Los_Angeles:20261028T090000
DTSTART;TZID=America/Los_Angeles:20261027T150000
DTEND;TZID=America/Los_Angeles:20261027T153000
SUMMARY:LA standup (moved from tomorrow)
END:VEVENT
BEGIN:VEVENT
UID:cancel-me
DTSTART;TZID=America/New_York:20261020T120000
DTEND;TZID=America/New_York:20261020T130000
RRULE:FREQ=WEEKLY
SUMMARY:Lunch
END:VEVENT
BEGIN:VEVENT
UID:cancel-me
RECURRENCE-ID;TZID=America/New_York:20261027T120000
DTSTART;TZID=America/New_York:20261027T120000
DTEND;TZID=America/New_York:20261027T130000
STATUS:CANCELLED
SUMMARY:Lunch
END:VEVENT
BEGIN:VEVENT
UID:floating
DTSTART:20261027T080000
DTEND:20261027T083000
SUMMARY:Floating breakfast
END:VEVENT
BEGIN:VEVENT
UID:trip
DTSTART;VALUE=DATE:20261026
DTEND;VALUE=DATE:20261029
SUMMARY:Family trip
END:VEVENT
BEGIN:VEVENT
UID:windows
DTSTART;TZID="Eastern Standard Time":20261027T200000
DTEND;TZID="Eastern Standard Time":20261027T210000
SUMMARY:Outlook thing
END:VEVENT
END:VCALENDAR`;

await test('Edge cases: missing VTIMEZONE, moved/cancelled occurrences, floating, all-day span, Windows zone', async () => {
  const day = dayFor(at('2026-10-27T12:00:00-04:00'), TZ);
  const items = itemsForDay(EDGE, { id: 'x' }, day);
  const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
  assert.equal(local(byTitle['LA standup'].start), '12:00');
  assert.equal(local(byTitle['LA standup (moved from tomorrow)'].start), '18:00');
  assert.ok(!byTitle['Lunch']);
  assert.equal(local(byTitle['Floating breakfast'].start), '8:00');
  assert.equal(byTitle['Family trip'].allDay, true);
  assert.equal(local(byTitle['Outlook thing'].start), '20:00');
  assert.equal(items.length, 5);
});

await test('Free gaps only between busy obligations', async () => {
  const ev = (uid: string, s: string, e: string, title: string, extra = '') => `BEGIN:VEVENT\nUID:${uid}\nDTSTART;TZID=America/New_York:20261027T${s}\nDTEND;TZID=America/New_York:20261027T${e}\nSUMMARY:${title}\n${extra}END:VEVENT\n`;
  const classes = `BEGIN:VCALENDAR\n${ev('a', '090000', '095000', 'Class A')}${ev('b', '130000', '135000', 'Class B')}${ev('c', '160000', '165000', 'Optional talk', 'TRANSP:TRANSPARENT\n')}END:VCALENDAR`;
  const home = `BEGIN:VCALENDAR\n${ev('gym', '070000', '073000', 'Gym')}${ev('lunch', '110000', '120000', 'Lunch')}${ev('dinner', '190000', '200000', 'Dinner')}END:VCALENDAR`;
  const feeds: Record<string, string> = { classes, home };
  const cfg: Config = { timezone: TZ, sources: [{ id: 'classes' }, { id: 'home', busy: false }] };
  const d = await buildToday({ config: cfg, load: async (s) => feeds[s.id], nowMs: at('2026-10-27T06:00:00-04:00') });
  assert.deepEqual(d.gaps.map((g) => g.label), ['1 h 10 min free', '1 h free'], 'both sides of lunch, nothing before the first class or after the last');
  const strict = await buildToday({ config: { ...cfg, free_gap_min: 90 }, load: async (s) => feeds[s.id], nowMs: at('2026-10-27T06:00:00-04:00') });
  assert.deepEqual(strict.gaps, []);
  const off = await buildToday({ config: { ...cfg, free_gap_min: 0 }, load: async (s) => feeds[s.id], nowMs: at('2026-10-27T06:00:00-04:00') });
  assert.deepEqual(off.gaps, []);
  const allBusy = await buildToday({ config: { timezone: TZ, sources: [{ id: 'classes' }, { id: 'home' }] }, load: async (s) => feeds[s.id], nowMs: at('2026-10-27T06:00:00-04:00') });
  assert.deepEqual(allBusy.gaps.map((g) => g.label), ['1 h 30 min free', '1 h 10 min free', '1 h free', '2 h 10 min free', '2 h 10 min free']);
});

await test('TRMNL settings in the query override config defaults', async () => {
  const cfg: Config = { timezone: 'America/New_York', clock: '12', free_gap_min: 45, sources: [] };
  const base = await buildToday({ config: cfg, nowMs: at('2026-10-27T13:30:00-04:00') });
  assert.equal(base.now.label, '1:30 PM');
  const over = await buildToday({ config: cfg, nowMs: at('2026-10-27T13:30:00-04:00'), clock: '24', tz: 'Europe/London', freeGapMin: 0 });
  assert.equal(over.now.label, '17:30');
  const bad = await buildToday({ config: cfg, nowMs: at('2026-10-27T13:30:00-04:00'), tz: 'Not/AZone' });
  assert.equal(bad.now.label, '1:30 PM', 'an invalid zone falls back to the config');
  const res = await handle(new Request('https://x.test/api/today?key=s3cret&clock=24&tz=Europe/London&gap=0&now=2026-10-27T13:30:00-04:00'), { TOKEN: 's3cret', CONFIG: JSON.stringify(cfg) });
  assert.equal((await res.json()).now.label, '17:30');
  const denied = await handle(new Request('https://x.test/api/today?key=wrong'), { TOKEN: 's3cret', CONFIG: JSON.stringify(cfg) });
  assert.equal(denied.status, 401);
});

await test('Config accepts a bare sources array and reads timezone and clock', async () => {
  const cfg = parseConfig('[{ "id": "x" }]');
  assert.deepEqual(cfg, { sources: [{ id: 'x' }] });
  const d = await buildToday({ config: { timezone: 'Europe/London', clock: '24', sources: [] }, nowMs: at('2026-10-27T13:30:00-04:00') });
  assert.equal(d.now.label, '17:30');
});

await test('A shorter event well inside a longer one nests with an indent', async () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:long
DTSTART;TZID=America/New_York:20261027T100000
DTEND;TZID=America/New_York:20261027T140000
SUMMARY:Clinic
END:VEVENT
BEGIN:VEVENT
UID:inner
DTSTART;TZID=America/New_York:20261027T130000
DTEND;TZID=America/New_York:20261027T141500
SUMMARY:Lecture
END:VEVENT
END:VCALENDAR`;
  const d = await run(inline(ics), '2026-10-27T09:00:00-04:00');
  const [clinic, lecture] = d.events;
  assert.deepEqual([clinic.depth, clinic.x, clinic.w, clinic.lanes], [0, 0, 1, 1]);
  assert.deepEqual([lecture.depth, lecture.x, lecture.w, lecture.lanes], [1, 0, 1, 1]);
});

await test('Overlapping events whose texts would collide split into columns', async () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:long
DTSTART;TZID=America/New_York:20261027T113000
DTEND;TZID=America/New_York:20261027T163000
SUMMARY:Long thing
END:VEVENT
BEGIN:VEVENT
UID:short
DTSTART;TZID=America/New_York:20261027T114500
DTEND;TZID=America/New_York:20261027T124500
SUMMARY:Short thing
END:VEVENT
BEGIN:VEVENT
UID:after
DTSTART;TZID=America/New_York:20261027T170000
DTEND;TZID=America/New_York:20261027T180000
SUMMARY:After
END:VEVENT
END:VCALENDAR`;
  const d = await run(inline(ics), '2026-10-27T11:00:00-04:00');
  const [long, short, after] = d.events;
  assert.deepEqual([long.lane, long.lanes, long.x, long.w, long.depth], [0, 2, 0, 0.4, 0]);
  assert.deepEqual([short.lane, short.lanes, short.x, short.w, short.depth], [1, 2, 0.4, 0.6, 0]);
  assert.deepEqual([after.lanes, after.x, after.w], [1, 0, 1]);
});

await test('Short events keep their real height next to the stretched block', async () => {
  const busy: Config = parseConfig(await readFile(new URL('fixtures/busy.json', root), 'utf8'));
  const d = await buildToday({ config: busy, load, nowMs: at('2026-10-27T10:00:00-04:00') });
  const advising = d.events.find((e) => e.title === 'Mentor check-in')!;
  const lab = d.events.find((e) => e.title === 'Chemistry Lab')!;
  assert.ok(advising.rh < advising.h);
  assert.equal(advising.rh, Math.round((15 / (14 * 60)) * 10000) / 10000);
  assert.equal(lab.rh, lab.h);
});

console.log(`\n${passed} passed`);
