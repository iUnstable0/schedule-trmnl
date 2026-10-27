import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildToday, fetchText, itemsForDay, parseConfig, type Day, type Item, type Source } from './src/today.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.liquid': 'text/plain', '.ics': 'text/calendar' };
const FEED_TTL = 10 * 60 * 1000;
const feeds = new Map<string, { text: string; at: number }>();
const parsed = new Map<string, Item[]>();

async function loadFeed(url: string, reload: boolean): Promise<string> {
  const hit = feeds.get(url);
  if (hit && !reload && Date.now() - hit.at < FEED_TTL) return hit.text;
  const text = await fetchText(url);
  feeds.set(url, { text, at: Date.now() });
  parsed.clear();
  return text;
}

async function itemsCached(s: Source, day: Day, reload: boolean): Promise<Item[]> {
  const text = s.file ? await readFile(join(ROOT, s.file), 'utf8') : await loadFeed(s.url!, reload);
  const key = `${s.id}|${s.file || s.url}|${day.ymd}`;
  const hit = parsed.get(key);
  if (hit && !reload) return hit;
  const items = itemsForDay(text, s, day);
  parsed.set(key, items);
  return items;
}

createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/today') {
      const src = url.searchParams.get('src');
      const file = src === 'live' ? 'config.json' : src === 'busy' ? 'fixtures/busy.json' : 'fixtures/config.json';
      const config = parseConfig(await readFile(join(ROOT, file), 'utf8'));
      const reload = url.searchParams.has('reload');
      const nowParam = url.searchParams.get('now');
      const data = await buildToday({
        config, itemsFor: (s, day) => itemsCached(s, day, reload),
        clock: url.searchParams.get('clock') === '24' ? '24' : '12',
        nowMs: nowParam ? Date.parse(nowParam) : Date.now(),
      });
      const fetchedAt = Math.min(...config.sources.filter((x) => x.url).map((x) => feeds.get(x.url!)?.at ?? Date.now()));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-feeds-fetched-at': String(Number.isFinite(fetchedAt) ? fetchedAt : Date.now()) });
      return res.end(JSON.stringify(data, null, 2));
    }
    const path = normalize(join(ROOT, url.pathname === '/' ? 'preview.html' : decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT) || path.includes('node_modules') || (path.endsWith('config.json') && !path.includes('fixtures'))) {
      res.writeHead(404); return res.end();
    }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    res.writeHead(code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
    res.end(String(code === 'ENOENT' ? 'not found' : (err as Error).stack || err));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`preview: http://localhost:${PORT}/preview.html`));
