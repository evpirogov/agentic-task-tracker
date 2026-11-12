// The admin over a project: a tiny HTTP server (node built-ins only), read-only but for one
// thing — the order of the initiatives' rows, dragged on the board (through lib.mjs, as the
// CLI's `initiative order`); every other write goes through the CLI.
// One page app (ui/index.html + modules) for every route: /tasks, /wiki/<page>, /code/<view>,
// /p/<id> (a project page), /session/<id>; the client routes. The data:
//   GET /api/project        name, which sections exist, pages (.tasks/project.json)
//   GET /api/board          the store (exportDb) + project + audits (id, ts, title, task verdicts)
//   GET /api/wiki           its pages (title, mtime, links); /api/wiki/doc?path=, /api/wiki/asset?path=,
//                           /api/wiki/search?q=
//   GET /api/code           scan + audits (code.mjs); /api/code/file?path=
//   GET /api/session?id=    a Claude Code transcript, readable
//   GET /api/stream         server-sent events: "change" (tasks), "wiki", "code"
//   GET /theme.css          the project's colours (.tasks/project.json theme), empty without one
//   POST /api/initiatives/order  {ids: [...]}: the rows' order, top first
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';
import * as C from './code.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
// every path the client routes gets the one page
const APP = /^\/($|tasks|wiki|code|p\/|session\/)/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const TRIES = 20; // ports tried upward when the asked one is taken
const SKIP = /(^|\/)(node_modules|\.git|dist|build)(\/|$)/;

function board(root) {
  // workflow.json may change while serving: open the store afresh every time
  const db = L.openDb(root);
  const audits = L.loadAudits(db).map((a) => ({ id: a.id, ts: a.ts, title: a.title, tasks: a.tasks ?? {} }));
  return { project: path.basename(root), root, ...L.exportDb(db), audits };
}

// which sections a project has: the wiki only with its dir, the code only when configured or audited
function sections(root) {
  const db = L.openDb(root);
  const cfg = C.loadProject(db);
  const file = path.join(db.dir, C.PROJECT);
  let raw = {};
  try { raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; } catch {}
  const dir = wikiDir(root, cfg);
  return {
    name: cfg.name,
    root,
    wiki: !!(dir && fs.existsSync(dir)),
    code: !!raw.code || L.loadAudits(db).length > 0,
    pages: cfg.pages,
  };
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, v, code = 200) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(v));

// a path the client names must stay inside `base`
function inside(base, rel) {
  const abs = path.resolve(base, String(rel ?? ''));
  return abs === base || abs.startsWith(base + path.sep) ? abs : null;
}

// ---------- wiki: markdown pages under the project's wiki dir ----------

function wikiDir(root, cfg) {
  return cfg.wiki?.dir ? path.resolve(root, cfg.wiki.dir) : null;
}

// the other pages a page links to (relative .md links, resolved against its folder)
function pageLinks(rel, text) {
  const out = new Set();
  const base = path.posix.dirname(rel);
  for (const m of text.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(m[1])) continue;
    const to = path.posix.normalize(path.posix.join(base, m[1]));
    if (!to.startsWith('..') && to !== rel) out.add(to);
  }
  return [...out];
}

// full-text search over the wiki: the pages that have the words, a few lines each
function wikiSearch(root, cfg, q) {
  const dir = wikiDir(root, cfg);
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!dir || !fs.existsSync(dir) || !words.length) return [];
  const out = [];
  for (const p of wikiPages(root, cfg).pages) {
    const lines = fs.readFileSync(path.join(dir, p.path), 'utf8').split('\n');
    const low = lines.map((l) => l.toLowerCase());
    if (!words.every((w) => low.some((l) => l.includes(w)))) continue;
    const hits = [];
    low.forEach((l, i) => { if (hits.length < 3 && words.some((w) => l.includes(w))) hits.push({ line: i + 1, text: lines[i].replace(/^[#>\-*\s|]+/, '').slice(0, 240) }); });
    out.push({ path: p.path, title: p.title, count: low.filter((l) => words.some((w) => l.includes(w))).length, hits });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 30);
}

function wikiPages(root, cfg) {
  const dir = wikiDir(root, cfg);
  if (!dir || !fs.existsSync(dir)) return null;
  const pages = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.md')) {
        const text = fs.readFileSync(abs, 'utf8');
        const rel = path.relative(dir, abs).split(path.sep).join('/');
        pages.push({ path: rel, title: /^#\s+(.+)$/m.exec(text)?.[1].trim() ?? rel, size: text.length, mtime: fs.statSync(abs).mtime.toISOString(), links: pageLinks(rel, text) });
      }
    }
  };
  walk(dir);
  return { dir: path.relative(root, dir), home: cfg.wiki.home ?? 'README.md', pages };
}

// ---------- sessions: Claude Code transcripts of this project ----------

const transcriptDir = (root) => path.join(os.homedir(), '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));

function partText(p) {
  if (typeof p === 'string') return p;
  if (p.type === 'text') return p.text;
  return '';
}

// The readable part: what the user wrote, what the agent answered, the tools it ran (names and
// a short gist), compaction summaries. Tool output and thinking stay out.
function readSession(root, id) {
  if (!/^[\w-]+$/.test(id)) return null;
  const file = path.join(transcriptDir(root), `${id}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const msgs = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'summary' && e.summary) { msgs.push({ role: 'summary', text: e.summary }); continue; }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const c = e.message?.content;
    const parts = Array.isArray(c) ? c : [c];
    const text = parts.map(partText).filter(Boolean).join('\n').trim();
    const tools = parts.filter((p) => p?.type === 'tool_use').map((p) => ({ name: p.name, gist: String(p.input?.description ?? p.input?.file_path ?? p.input?.command ?? p.input?.pattern ?? p.input?.prompt ?? '').slice(0, 200) }));
    if (e.type === 'user' && parts.every((p) => p?.type === 'tool_result')) continue;
    if (!text && !tools.length) continue;
    const role = e.type === 'user' ? (e.isCompactSummary || /^This session is being continued/.test(text) ? 'summary' : 'user') : 'agent';
    msgs.push({ role, ts: e.timestamp ?? null, text, tools });
  }
  return { id, file, size: fs.statSync(file).size, messages: msgs };
}

// ---------- the code state is costly: computed once per change ----------

function codeCache(root) {
  let val = null;
  return {
    get() {
      if (!val) val = C.codeState(L.openDb(root), { guardians: 'cache' }); // the guardians' check is slow: its kept marks (tasks code runs it)
      return val;
    },
    drop() { val = null; },
  };
}

// one event per burst of writes, by kind
function watch(root, cfg, push) {
  const timers = {};
  const fire = (kind) => { clearTimeout(timers[kind]); timers[kind] = setTimeout(() => push(kind), 150); };
  const wiki = wikiDir(root, cfg);
  const wikiRel = wiki ? path.relative(root, wiki) + '/' : null;
  const inCode = (rel) => cfg.code.include.some((g) => rel.startsWith(g.replace(/\*.*$/, ''))) && !cfg.code.exclude.some((g) => rel.startsWith(g));
  const onFile = (rel) => {
    rel = rel.split(path.sep).join('/');
    if (SKIP.test(rel) || rel.endsWith('.tmp')) return;
    if (rel.startsWith(L.DIR + '/')) {
      fire('change');
      if (/^\.tasks\/(audits|tech)\/|project\.json$/.test(rel)) fire('code');
    } else if (wikiRel && rel.startsWith(wikiRel)) fire('wiki');
    if (inCode(rel)) fire('code');
  };
  try {
    return fs.watch(root, { recursive: true }, (_ev, file) => file && onFile(String(file)));
  } catch {
    const dir = path.join(root, L.DIR);
    const ws = [dir, path.join(dir, 'items')].filter((d) => fs.existsSync(d)).map((d) => fs.watch(d, () => fire('change')));
    return { close: () => ws.forEach((w) => w.close()) };
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

export function serve(root, { port = 4747, host = '127.0.0.1', open = false } = {}) {
  const clients = new Set();
  const project = () => C.loadProject(L.openDb(root));
  const code = codeCache(root);
  const page = (res, file) => send(res, 200, TYPES['.html'], fs.readFileSync(path.join(UI, file)));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'POST' && p === '/api/initiatives/order') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        try {
          const ids = JSON.parse(body || '{}').ids;
          if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return send(res, 400, 'text/plain', 'ids: [string]');
          L.orderInitiatives(L.openDb(root), ids);
          json(res, { ok: true });
        } catch (e) { send(res, e instanceof L.TaskError || e instanceof SyntaxError ? 400 : 500, 'text/plain', e.message); }
      });
      return;
    }
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'read-only');
    try {
      if (APP.test(p)) return page(res, 'index.html');
      if (p.startsWith('/ui/')) {
        const abs = inside(UI, p.slice(4));
        if (!abs || !fs.existsSync(abs)) return send(res, 404, 'text/plain', 'not found');
        return send(res, 200, TYPES[path.extname(abs)] ?? 'application/octet-stream', fs.readFileSync(abs));
      }
      if (p === '/theme.css') {
        const rel = project().theme;
        const abs = rel && inside(root, rel);
        return send(res, 200, TYPES['.css'], abs && fs.existsSync(abs) ? fs.readFileSync(abs) : '');
      }
      if (p === '/api/board') return json(res, board(root));
      if (p === '/api/project') return json(res, sections(root));
      if (p === '/api/wiki') return json(res, wikiPages(root, project()) ?? { pages: [] });
      if (p === '/api/wiki/search') return json(res, wikiSearch(root, project(), url.searchParams.get('q')));
      if (p === '/api/wiki/doc' || p === '/api/wiki/asset') {
        const dir = wikiDir(root, project());
        const abs = dir && inside(dir, url.searchParams.get('path'));
        if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return send(res, 404, 'text/plain', 'not found');
        if (p === '/api/wiki/asset') return send(res, 200, TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream', fs.readFileSync(abs));
        return json(res, { path: url.searchParams.get('path'), text: fs.readFileSync(abs, 'utf8'), mtime: fs.statSync(abs).mtime.toISOString() });
      }
      if (p === '/api/code') return json(res, code.get());
      if (p === '/api/code/file') {
        const rel = url.searchParams.get('path');
        if (!code.get().files[rel]) return send(res, 404, 'text/plain', 'not a scanned file');
        return json(res, { path: rel, text: fs.readFileSync(path.join(root, rel), 'utf8') });
      }
      if (p === '/api/session') {
        const s = readSession(root, url.searchParams.get('id') ?? '');
        return s ? json(res, s) : json(res, { error: 'no such session transcript' }, 404);
      }
      if (p === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 1500\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  });
  const push = (ev) => {
    if (ev === 'code') code.drop();
    for (const c of clients) c.write(`event: ${ev}\ndata: {}\n\n`);
  };
  const watcher = watch(root, project(), push);
  // proxies and sleeping laptops drop quiet connections
  const ping = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

  let tries = 0;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && ++tries < TRIES) return server.listen(++port, host);
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`;
    // open to the network: its addresses there too (a page on localhost opens at the same host: ui/app.js pageUrl)
    const lan = host !== '0.0.0.0' ? [] : Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => `  http://${a.address}:${port}/  (network)\n`);
    console.log(`admin for ${path.basename(root)} (${path.join(root, L.DIR)})\n  ${url}\n${lan.join('')}live: updates on every change — Ctrl+C to stop`);
    if (open) openBrowser(url);
  });
  const stop = () => { clearInterval(ping); watcher.close(); for (const c of clients) c.end(); server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}
