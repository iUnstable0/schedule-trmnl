import ICAL from 'ical.js';
import { DateTime, IANAZone } from 'luxon';

export interface Source {
  id: string;
  label?: string;
  tag?: string;
  kind?: 'due';
  busy?: boolean;
  url?: string;
  file?: string;
}

export interface Config {
  timezone?: string;
  clock?: Clock;
  free_gap_min?: number;
  sources: Source[];
}

export interface Day {
  tz: string;
  ymd: string;
  start: number;
  end: number;
}

export interface Item {
  src: string;
  uid: string;
  title: string;
  location: string;
  busy: boolean;
  allDay: boolean;
  start: number;
  end: number;
}

export type Clock = '12' | '24';
export type EventState = 'past' | 'now' | 'next' | 'later';
export type Phase = 'morning' | 'day' | 'done' | 'empty';

export interface ScreenEvent {
  title: string;
  meta: string;
  tag: string;
  due: string;
  start_label: string;
  state: EventState;
  y: number;
  h: number;
  rh: number;
  lane: number;
  lanes: number;
  depth: number;
  x: number;
  w: number;
}

export interface DueItem {
  title: string;
  kind: string;
  subject: string;
  course: string;
  all_day: boolean;
  time: string;
  passed: boolean;
}

export interface DueGroup {
  time: string;
  course: string;
  passed: boolean;
  all_day: boolean;
  items: { kind: string; subject: string }[];
}

export interface UpNext {
  kind: 'event' | 'due';
  title: string;
  time: string;
  ends: string;
  place: string;
  tag: string;
  note: string;
}

export interface Screen {
  weekday: string;
  date: string;
  summary: string;
  updated: string;
  updated_at: string;
  phase: Phase;
  now: { y: number; label: string; before: boolean; after: boolean };
  window: { start: string; end: string };
  ticks: { y: number; label: string }[];
  events: ScreenEvent[];
  gaps: { y: number; h: number; label: string; state: 'past' | 'next' }[];
  marks: { y: number; count: number; label: string; passed: boolean }[];
  edges: { side: 'before' | 'after'; label: string; passed: boolean }[];
  has_current: boolean;
  up_next: UpNext | null;
  due: DueItem[];
  due_groups: DueGroup[];
  due_count: number;
  all_day: { title: string; tag: string }[];
  errors: string[];
}

interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number }

const inZone = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz, locale: 'en-US' });

export function partsIn(ms: number, tz: string): Parts {
  const d = inZone(ms, tz);
  return { y: d.year, mo: d.month, d: d.day, h: d.hour, mi: d.minute, s: d.second };
}

export function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  return DateTime.fromObject({ year: y, month: mo, day: d, hour: h, minute: mi, second: s }, { zone: tz }).toMillis();
}

const isIana = (tz: string) => IANAZone.isValidZone(tz);

const WINDOWS_TZ: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin',
  'SE Asia Standard Time': 'Asia/Bangkok', 'Tokyo Standard Time': 'Asia/Tokyo',
};

type Time = ICAL.Time & { timezone?: string };

function zoneName(t: Time): string | null {
  if (t.zone === ICAL.Timezone.utcTimezone) return 'UTC';
  const z = t.zone && t.zone.tzid;
  if (z && z !== 'floating') return z;
  return t.timezone || null;
}

function resolveZone(name: string | null | undefined, fallback: string): string {
  if (!name) return fallback;
  if (name === 'UTC' || name === 'Z' || name === 'GMT') return 'UTC';
  const n = name.replace(/^"|"$/g, '');
  if (isIana(n)) return n;
  if (WINDOWS_TZ[n]) return WINDOWS_TZ[n];
  const tail = n.match(/([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/);
  if (tail && isIana(tail[1])) return tail[1];
  return fallback;
}

function timeToMs(t: Time, hint: string | undefined, tz: string): number {
  const zone = resolveZone(zoneName(t) || hint, tz);
  if (zone === 'UTC') return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  return wallToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, zone);
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const timeYmd = (t: Time) => ymd(t.year, t.month, t.day);
const addDays = (ymdStr: string, n: number) => DateTime.fromISO(ymdStr, { zone: 'utc' }).plus({ days: n }).toISODate()!;

export function dayFor(nowMs: number, tz: string): Day {
  const d = inZone(nowMs, tz).startOf('day');
  return { tz, ymd: d.toISODate()!, start: d.toMillis(), end: d.plus({ days: 1 }).toMillis() };
}

const DAY_MS = 86400000;
const clean = (s: unknown) => String(s ?? '').replace(/[​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim();

function isCancelled(comp: ICAL.Component): boolean {
  return String(comp.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED';
}

export function itemsForDay(text: string, src: Pick<Source, 'id'>, day: Day): Item[] {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    const id = vtz.getFirstPropertyValue('tzid') as string | null;
    if (id && !ICAL.TimezoneService.has(id)) ICAL.TimezoneService.register(vtz);
  }

  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Component[] = [];
  let n = 0;
  for (const ve of root.getAllSubcomponents('vevent')) {
    if (ve.hasProperty('recurrence-id')) exceptions.push(ve);
    else masters.set((ve.getFirstPropertyValue('uid') as string) || `__${n++}`, new ICAL.Event(ve));
  }
  for (const ve of exceptions) {
    const m = masters.get(ve.getFirstPropertyValue('uid') as string);
    if (m) m.relateException(ve);
  }

  const out: Item[] = [];
  const seen = new Set<string>();

  const consider = (item: ICAL.Event, s: Time | null, e: Time | null, hintS?: string, hintE?: string) => {
    if (!s || isCancelled(item.component)) return;
    const transp = String(item.component.getFirstPropertyValue('transp') || '').toUpperCase();
    const base = { src: src.id, uid: item.uid || '', title: clean(item.summary) || '(no title)', location: String(item.location || '').trim(), busy: transp !== 'TRANSPARENT' };
    if (s.isDate) {
      const sy = timeYmd(s);
      let ey = e ? timeYmd(e) : null;
      if (!ey || ey <= sy) ey = addDays(sy, 1);
      if (sy <= day.ymd && day.ymd < ey) {
        const key = `${base.uid}|${sy}`;
        if (!seen.has(key)) { seen.add(key); out.push({ ...base, allDay: true, start: 0, end: 0 }); }
      }
      return;
    }
    const sm = timeToMs(s, hintS, day.tz);
    let em = e ? timeToMs(e, hintE || hintS, day.tz) : sm;
    if (em < sm) em = sm;
    const hits = sm === em ? (sm >= day.start && sm < day.end) : (sm < day.end && em > day.start);
    if (!hits) return;
    const key = `${base.uid}|${sm}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...base, allDay: false, start: sm, end: em });
  };

  for (const ev of masters.values()) {
    if (isCancelled(ev.component)) continue;
    const hintS = (ev.startDate as Time | null)?.timezone;
    const hintE = (ev.endDate as Time | null)?.timezone;
    if (!ev.isRecurring()) { consider(ev, ev.startDate, ev.endDate, hintS, hintE); continue; }
    const it = ev.iterator();
    const stopYmd = addDays(day.ymd, 2);
    let next: Time | null | undefined, guard = 0;
    while ((next = it.next()) && guard++ < 50000) {
      if (next.isDate ? timeYmd(next) > stopYmd : timeToMs(next, hintS, day.tz) > day.end + DAY_MS) break;
      const det = ev.getOccurrenceDetails(next);
      consider(det.item, det.startDate, det.endDate, (det.item.startDate as Time).timezone || hintS, (det.item.endDate as Time | null)?.timezone || hintE);
    }
  }
  for (const ve of exceptions) {
    const ex = new ICAL.Event(ve);
    consider(ex, ex.startDate, ex.endDate, (ex.startDate as Time | null)?.timezone, (ex.endDate as Time | null)?.timezone);
  }
  return out;
}

function tidyDue(title: string): { title: string; course: string } {
  const m = title.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  if (!m) return { title, course: '' };
  const course = m[2].replace(/\s*\(\d+\)/g, '').replace(/\s+(FA|SP|SU|WI|FALL|SPRING|SUMMER|WINTER)\s?\d{2,4}$/i, '').trim();
  return { title: m[1], course };
}

const firstLine = (s: string) => String(s || '').split('\n')[0].trim();

const fmtClock = (ms: number, tz: string, clock: Clock) => inZone(ms, tz).toFormat(clock === '24' ? 'HH:mm' : 'h:mm a');
function fmtRange(s: number, e: number, tz: string, clock: Clock): string {
  const a = fmtClock(s, tz, clock), b = fmtClock(e, tz, clock);
  if (s === e) return a;
  if (clock !== '24' && a.slice(-2) === b.slice(-2)) return `${a.slice(0, -3)} – ${b}`;
  return `${a} – ${b}`;
}
function fmtHour(m: number, clock: Clock): string {
  const h = Math.floor(m / 60) % 24;
  if (clock === '24') return pad(h);
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
}
export function fmtDuration(min: number): string {
  min = Math.max(0, Math.round(min));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
function splitDue(title: string): { kind: string; subject: string } {
  const m = title.match(/^([A-Za-z][A-Za-z0-9 #.\-]{0,24}?):\s+(.+)$/);
  return m ? { kind: m[1], subject: m[2] } : { kind: title, subject: '' };
}
const r4 = (x: number) => Math.round(x * 10000) / 10000;

interface Timed {
  title: string; place: string; tag: string; busy: boolean; start: number; end: number; sm: number; em: number;
  state: EventState; vs: number; ve: number; lane: number; lanes: number; depth: number; x: number; w: number;
}
interface Due extends DueItem { m: number }
interface Cluster { lanes: number[]; start: number; end: number; realStart: number; realEnd: number; evs: Timed[] }

export interface BuildInput {
  items: Item[];
  sources: Source[];
  errors?: string[];
  nowMs: number;
  day: Day;
  clock?: Clock;
  freeGapMin?: number;
}

export function buildScreen({ items, sources, errors = [], nowMs, day, clock = '12', freeGapMin = 45 }: BuildInput): Screen {
  const tz = day.tz;
  const srcById: Record<string, Source> = Object.fromEntries(sources.map((s) => [s.id, s]));
  const toM = (ms: number) => (ms - day.start) / 60000;
  const dayLen = toM(day.end);
  const nowM = toM(nowMs);

  const timed: Timed[] = [], allDay: { title: string; tag: string }[] = [], due: Due[] = [];
  for (const it of items) {
    const src = srcById[it.src] || { id: it.src };
    if (src.kind === 'due' && (it.allDay || it.end - it.start <= 60000 || /assignment/i.test(it.uid))) {
      const d = tidyDue(it.title);
      const { kind, subject } = splitDue(d.title);
      due.push({
        title: d.title, kind, subject, course: d.course, all_day: it.allDay,
        m: it.allDay ? dayLen : toM(it.start),
        time: it.allDay ? 'Today' : fmtClock(it.start, tz, clock), passed: !it.allDay && it.start <= nowMs,
      });
      continue;
    }
    const title = it.title;
    const place = firstLine(it.location);
    const tag = src.tag || '';
    if (it.allDay) { allDay.push({ title, tag }); continue; }
    timed.push({
      title, place, tag, busy: it.busy && src.busy !== false, start: it.start, end: it.end, sm: Math.max(0, toM(it.start)), em: Math.min(dayLen, toM(it.end)),
      state: 'later', vs: 0, ve: 0, lane: 0, lanes: 1, depth: 0, x: 0, w: 1,
    });
  }
  timed.sort((a, b) => a.sm - b.sm || b.em - a.em);
  due.sort((a, b) => a.m - b.m);

  let nextEv: Timed | null = null;
  for (const e of timed) {
    e.state = e.em <= nowM && e.end > e.start ? 'past' : e.sm <= nowM && nowM < e.em ? 'now' : e.sm <= nowM ? 'past' : 'later';
    if (e.state === 'later' && !nextEv) { nextEv = e; e.state = 'next'; }
  }

  const MIN_SPAN = 360;
  let ws = 8 * 60, we = 20 * 60;
  if (timed.length) {
    ws = Math.max(0, Math.floor((Math.min(...timed.map((e) => e.sm)) - 30) / 60) * 60);
    we = Math.min(dayLen, Math.ceil((Math.max(...timed.map((e) => e.em)) + 30) / 60) * 60);
  }
  if (we - ws < MIN_SPAN) we = Math.min(dayLen, ws + MIN_SPAN);
  if (we - ws < MIN_SPAN) ws = Math.max(0, we - MIN_SPAN);
  const span = we - ws;
  const yOf = (m: number) => r4(Math.min(1, Math.max(0, (m - ws) / span)));

  const MIN_VIS = Math.max(20, span / 24);
  let cluster: Cluster | null = null;
  const clusters: Cluster[] = [];
  for (const e of timed) {
    e.vs = Math.max(e.sm, ws);
    e.ve = Math.min(Math.max(e.em, e.vs + MIN_VIS), we);
    if (!cluster || e.vs >= cluster.end) { cluster = { lanes: [], start: e.vs, end: 0, realStart: e.sm, realEnd: 0, evs: [] }; clusters.push(cluster); }
    let li = cluster.lanes.findIndex((end) => end <= e.vs);
    if (li < 0) { li = cluster.lanes.length; cluster.lanes.push(e.ve); } else cluster.lanes[li] = e.ve;
    e.lane = li;
    cluster.end = Math.max(cluster.end, e.ve);
    cluster.realEnd = Math.max(cluster.realEnd, e.em);
    cluster.evs.push(e);
  }
  const LANE_W: Record<number, number[]> = { 1: [1], 2: [0.4, 0.6], 3: [0.3, 0.35, 0.35] };
  const TL_PX = 640, TEXT_PX = 72;
  const px = (m: number) => (m / span) * TL_PX;
  const textClear = (parent: Timed, child: Timed) => px(child.vs - parent.vs) >= Math.min(px(parent.ve - parent.vs) - 4, TEXT_PX) + 6;
  for (const c of clusters) {
    const placed: Timed[] = [];
    let nestable = c.lanes.length > 1;
    for (const e of c.evs) {
      const over = placed.filter((p) => p.ve > e.vs);
      if (!over.every((p) => textClear(p, e))) { nestable = false; break; }
      e.depth = over.length ? Math.max(...over.map((p) => p.depth)) + 1 : 0;
      placed.push(e);
    }
    const n = c.lanes.length;
    const widths = nestable || n === 1 ? [1] : LANE_W[n] || Array(n).fill(1 / n);
    for (const e of c.evs) {
      if (nestable) { e.lanes = 1; e.x = 0; e.w = 1; continue; }
      e.depth = 0;
      e.lanes = n;
      e.x = widths.slice(0, e.lane).reduce((a, b) => a + b, 0);
      e.w = widths[e.lane];
    }
  }

  const gaps: Screen['gaps'] = [];
  const busyEvents = timed.filter((e) => e.busy);
  const betweenObligations = (from: number, to: number) => busyEvents.some((e) => e.em <= from) && busyEvents.some((e) => e.sm >= to);
  for (let i = 1; i < clusters.length && freeGapMin > 0; i++) {
    const from = clusters[i - 1].realEnd, to = clusters[i].realStart;
    if (to - from < freeGapMin || !betweenObligations(from, to)) continue;
    const top = clusters[i - 1].end, bottom = clusters[i].start;
    if (bottom - top < 20) continue;
    gaps.push({ y: yOf(top), h: r4((bottom - top) / span), label: `${fmtDuration(to - from)} free`, state: to <= nowM ? 'past' : 'next' });
  }

  const marks: { m: number; items: Due[]; passed: boolean }[] = [];
  for (const d of due) {
    if (d.all_day || d.m < ws || d.m > we) continue;
    const last = marks[marks.length - 1];
    if (last && last.m === d.m) { last.items.push(d); continue; }
    marks.push({ m: d.m, items: [d], passed: d.passed });
  }
  const markLabel = (items: Due[]) => items.length === 1 && items[0].subject ? `${items[0].kind} · ${items[0].subject}` : items.map((d) => d.kind).join(', ');
  const edgeLabel = (items: Due[]) => {
    if (items.length === 1) return [items[0].time, items[0].course, items[0].kind].filter(Boolean).join(' · ');
    const times = [...new Set(items.map((d) => d.time))];
    return `${items.length} due · ${times.join(', ')}`;
  };
  const edges: Screen['edges'] = [];
  const early = due.filter((d) => !d.all_day && d.m < ws);
  const late = due.filter((d) => !d.all_day && d.m > we);
  if (early.length) edges.push({ side: 'before', label: edgeLabel(early), passed: early.every((d) => d.passed) });
  if (late.length) edges.push({ side: 'after', label: edgeLabel(late), passed: late.every((d) => d.passed) });
  const dueByEvent = new Map<Timed, string>();
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) || [];
  const relates = (e: Timed, d: Due) => {
    if (!d.course) return true;
    const t = new Set(words(e.title));
    return words(d.course).some((w) => w.length > 2 && t.has(w));
  };
  const floating = marks.filter((k) => {
    const host = timed.find((e) => e.sm === k.m && e.em > e.sm && k.items.every((d) => relates(e, d)));
    if (host) { dueByEvent.set(host, markLabel(k.items)); return false; }
    return !timed.some((e) => e.sm <= k.m && k.m < e.em);
  });

  const meta = (e: Timed) => {
    const bits: string[] = [];
    if (e.state === 'now') bits.push(`until ${fmtClock(e.end, tz, clock)}`);
    else bits.push(e.start < day.start ? `until ${fmtClock(e.end, tz, clock)}` : e.end > day.end ? `from ${fmtClock(e.start, tz, clock)}` : fmtRange(e.start, e.end, tz, clock));
    if (e.place) bits.push(e.place);
    return bits.join(' · ');
  };

  const step = span <= 720 ? 60 : 120;
  const ticks: Screen['ticks'] = [];
  for (let m = Math.ceil(ws / step) * step; m <= we; m += step) ticks.push({ y: yOf(m), label: fmtHour(m, clock) });

  const nextDue = due.find((d) => !d.passed && !d.all_day);
  let upNext: UpNext | null = null;
  if (nextEv && (!nextDue || nextDue.m >= nextEv.sm)) {
    const ev: Timed = nextEv;
    const atStart = due.filter((d) => !d.passed && !d.all_day && d.m === ev.sm).length;
    upNext = {
      kind: 'event', title: ev.title, time: fmtClock(ev.start, tz, clock),
      ends: ev.end > ev.start ? `Ends ${fmtClock(ev.end, tz, clock)}` : '', place: ev.place, tag: ev.tag,
      note: atStart ? `${atStart} due when it starts` : '',
    };
  } else if (nextDue) {
    upNext = {
      kind: 'due', title: nextDue.title, time: nextDue.time, ends: '', place: nextDue.course, tag: '',
      note: nextEv ? `Then ${fmtClock(nextEv.start, tz, clock)} ${nextEv.title}` : '',
    };
  }

  const groups: DueGroup[] = [];
  for (const d of due) {
    const last = groups[groups.length - 1];
    if (last && last.time === d.time && last.course === d.course) last.items.push({ kind: d.kind, subject: d.subject });
    else groups.push({ time: d.time, course: d.course, passed: d.passed, all_day: d.all_day, items: [{ kind: d.kind, subject: d.subject }] });
  }

  const current = timed.filter((e) => e.state === 'now');
  const left = timed.filter((e) => e.state !== 'past').length;
  const dueLeft = due.filter((d) => !d.passed).length;
  const phase: Phase = !timed.length && !due.length ? 'empty' : left === timed.length && !current.length && timed.length ? 'morning' : upNext ? 'day' : 'done';
  const today = inZone(nowMs, tz);
  const weekday = today.toFormat('cccc');
  const dateLabel = today.toFormat('LLLL d');

  return {
    weekday, date: dateLabel,
    summary: phase === 'empty' ? 'Free day' : [left ? `${left} left` : 'All done', due.length ? `${dueLeft} due` : ''].filter(Boolean).join(' · '),
    updated: fmtClock(nowMs, tz, clock),
    updated_at: new Date(nowMs).toISOString(),
    phase,
    now: { y: yOf(nowM), label: fmtClock(nowMs, tz, clock), before: nowM < ws, after: nowM > we },
    window: { start: fmtHour(ws, clock), end: fmtHour(we, clock) },
    ticks,
    events: timed.map((e) => ({
      title: e.title, meta: meta(e), tag: e.tag, due: dueByEvent.get(e) || '', start_label: fmtClock(e.start, tz, clock),
      state: e.state, y: yOf(e.vs), h: r4((e.ve - e.vs) / span), rh: r4((Math.min(Math.max(e.em, e.vs), we) - e.vs) / span), lane: e.lane, lanes: e.lanes, depth: e.depth, x: r4(e.x), w: r4(e.w),
    })),
    gaps,
    marks: floating.map((k) => ({ y: yOf(k.m), count: k.items.length, label: markLabel(k.items), passed: k.passed })),
    edges,
    has_current: current.length > 0,
    up_next: upNext,
    due: due.map(({ m, ...d }) => d),
    due_groups: groups,
    due_count: due.length,
    all_day: allDay,
    errors,
  };
}

const toHttp = (u: string) => u.replace(/^webcals?:\/\//i, 'https://');

export async function fetchText(url: string, timeoutMs = 9000): Promise<string> {
  const res = await fetch(toHttp(url), { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'schedule-trmnl/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export interface TodayOptions {
  config: Config;
  nowMs?: number;
  clock?: Clock;
  tz?: string;
  freeGapMin?: number;
  load?: (s: Source) => Promise<string>;
  itemsFor?: (s: Source, day: Day) => Promise<Item[]>;
}

export async function buildToday({ config, nowMs = Date.now(), clock, tz: tzOverride, freeGapMin, load = (s) => fetchText(s.url!), itemsFor }: TodayOptions): Promise<Screen> {
  const tz = tzOverride && IANAZone.isValidZone(tzOverride) ? tzOverride : config.timezone || 'America/New_York';
  const sources = config.sources || [];
  const day = dayFor(nowMs, tz);
  const errors: string[] = [];
  const results = await Promise.all(sources.map(async (s) => {
    try { return itemsFor ? await itemsFor(s, day) : itemsForDay(await load(s), s, day); } catch (err) {
      errors.push(`${s.label || s.id}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }));
  return buildScreen({
    items: results.flat(), sources, errors, nowMs, day,
    clock: (clock || config.clock) === '24' ? '24' : '12',
    freeGapMin: freeGapMin ?? config.free_gap_min ?? 45,
  });
}

export type Env = Record<string, string | undefined>;

export function parseConfig(text: string | undefined): Config {
  const parsed = JSON.parse(text || '{}');
  return Array.isArray(parsed) ? { sources: parsed } : parsed;
}

export async function handle(request: Request, env: Env = {}): Promise<Response> {
  const url = new URL(request.url);
  if (env.TOKEN && url.searchParams.get('key') !== env.TOKEN) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  let config: Config;
  try { config = parseConfig(env.CONFIG); } catch { return Response.json({ error: 'CONFIG is not valid JSON' }, { status: 500 }); }
  const nowParam = url.searchParams.get('now');
  const nowMs = nowParam ? Date.parse(nowParam) : Date.now();
  const clock = url.searchParams.get('clock');
  const gap = Number(url.searchParams.get('gap'));
  const data = await buildToday({
    config, clock: clock === '24' ? '24' : clock === '12' ? '12' : undefined,
    tz: url.searchParams.get('tz') || undefined,
    freeGapMin: url.searchParams.has('gap') && Number.isFinite(gap) && gap >= 0 ? gap : undefined,
    nowMs: Number.isNaN(nowMs) ? Date.now() : nowMs,
  });
  return Response.json(data, { headers: { 'cache-control': 'no-store' } });
}
