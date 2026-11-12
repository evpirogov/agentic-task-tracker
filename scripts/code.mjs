// The code side of the tracker: what the project's source looks like right now (scan) and
// what the independent audits said about it (verdicts, findings) — merged into one state per
// file, which the CLI (tasks code) and the admin's code page show. Config: .tasks/project.json.
// No console output here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as L from './lib.mjs';

export const PROJECT = 'project.json';
export const FILE_STATUS = ['ok', 'debt', 'legacy', 'duplicate', 'inaccurate'];
export const FINDING_KINDS = ['duplicate', 'legacy', 'debt', 'inaccuracy', 'conflict', 'perf', 'bug', 'structure', 'state'];
export const PILLAR_STATUS = ['ok', 'risk', 'debt'];
const DEFAULT_CODE = {
  include: ['src/'],
  exclude: ['node_modules/', 'dist/', 'build/', '.git/'],
  ext: ['.js', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.lua', '.luau'],
  entries: [],
  areas: [],
  patterns: [],
  dup: { min_lines: 8, red_lines: 14, max_spread: 6 },
};

// ---------- config ----------

export function loadProject(db) {
  const file = path.join(db.dir, PROJECT);
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const code = { ...DEFAULT_CODE, ...(cfg.code ?? {}) };
  code.dup = { ...DEFAULT_CODE.dup, ...(cfg.code?.dup ?? {}) };
  return {
    name: cfg.name ?? path.basename(db.root),
    code,
    wiki: cfg.wiki ?? null, // { dir, home }
    tech: { pillars: 'tech/pillars.md', checks: 'tech/checks.md', ...(cfg.tech ?? {}) }, // paths under .tasks/
    pages: cfg.pages ?? [], // [{ id, title, url, start? }]
    serve: { host: '127.0.0.1', ...(cfg.serve ?? {}) }, // the admin's: host '0.0.0.0' opens it to the local network
    theme: cfg.theme ?? null, // a CSS file of the project (from its root) over the admin's tokens: its colours
  };
}

// "dir/" matches a folder, "*" anything but "/", "**" anything; otherwise an exact path
function globRe(g) {
  if (g.endsWith('/')) return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
  const re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp('^' + re + '$');
}
const anyGlob = (globs) => { const rs = globs.map(globRe); return (p) => rs.some((r) => r.test(p)); };

export function areaOf(cfg, file) {
  return cfg.code.areas.find((a) => anyGlob(a.paths)(file))?.id ?? null;
}

// ---------- files ----------

const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
export const blobHash = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

function listFiles(root, code) {
  const inc = anyGlob(code.include), exc = anyGlob(code.exclude);
  const tracked = git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard');
  const all = tracked.status === 0 ? tracked.stdout.split('\0').filter(Boolean) : [];
  return [...new Set(all)].filter((f) => inc(f) && !exc(f) && code.ext.includes(path.extname(f)) && fs.existsSync(path.join(root, f))).sort();
}

// last commit per file in one pass over the log
function lastCommits(root) {
  const out = new Map();
  const r = git(root, 'log', '--format=%x01%h %cI', '--name-only', '-n', '2000');
  if (r.status !== 0) return out;
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('\u0001')) { const [h, d] = line.slice(1).split(' '); cur = { commit: h, date: d }; }
    else if (line && cur && !out.has(line)) out.set(line, cur);
  }
  return out;
}

function dirtyFiles(root) {
  const r = git(root, 'status', '--porcelain', '-z', '--untracked-files=all');
  const out = new Set();
  if (r.status !== 0) return out;
  for (const e of r.stdout.split('\0')) if (e.length > 3) out.add(e.slice(3));
  return out;
}

// ---------- imports (ES modules, html scripts) ----------

const IMPORT_RES = [
  /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /<script[^>]*\ssrc=["']([^"']+)["']/g,
  /<link[^>]*\shref=["']([^"']+\.css)["']/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function importsOf(text) {
  const out = new Set();
  for (const re of IMPORT_RES) for (const m of text.matchAll(re)) out.add(m[1]);
  return [...out];
}

function resolveImport(from, spec, known) {
  if (!/^(\.{1,2}\/|\/)/.test(spec)) return null; // a package
  const base = spec.startsWith('/') ? spec.slice(1) : path.posix.join(path.posix.dirname(from), spec);
  const clean = path.posix.normalize(base.split('?')[0]);
  for (const c of [clean, clean + '.js', clean + '.mjs', clean + '.ts', clean + '/index.js']) if (known.has(c)) return c;
  return null;
}

// ---------- duplicates: identical runs of meaningful lines across files ----------

const TRIVIAL = /^[\s{}()[\];,]*$|^(import|export \{|\/\/|\/\*|\*)/;
function meaningfulLines(text) {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const s = raw.replace(/\s\/\/.*$/, '').trim().replace(/\s+/g, ' ');
    if (s.length >= 4 && !TRIVIAL.test(s)) out.push({ s, line: i + 1 });
  });
  return out;
}

function findDuplicates(texts, { min_lines: W, max_spread }) {
  const windows = new Map(); // hash → [[file, idx]]
  const lines = new Map();
  for (const [file, text] of texts) {
    if (!/\.(m?[jt]sx?|css|lua|luau)$/.test(file)) continue;
    const ls = meaningfulLines(text);
    lines.set(file, ls);
    for (let i = 0; i + W <= ls.length; i++) {
      const h = crypto.createHash('md5').update(ls.slice(i, i + W).map((x) => x.s).join('\n')).digest('base64');
      (windows.get(h) ?? windows.set(h, []).get(h)).push([file, i]);
    }
  }
  // every pair of places sharing a window, grouped by file pair
  const pairs = new Map();
  for (const occ of windows.values()) {
    if (occ.length < 2 || occ.length > max_spread) continue; // boilerplate everywhere is not a copy
    for (let a = 0; a < occ.length; a++) for (let b = a + 1; b < occ.length; b++) {
      let [fa, ia] = occ[a], [fb, ib] = occ[b];
      if (fa === fb && Math.abs(ia - ib) < W) continue;
      if (fa > fb || (fa === fb && ia > ib)) [fa, ia, fb, ib] = [fb, ib, fa, ia];
      const k = fa + '\n' + fb;
      (pairs.get(k) ?? pairs.set(k, new Set()).get(k)).add(`${ia},${ib}`);
    }
  }
  // consecutive windows → one block
  const blocks = [];
  for (const [k, set] of pairs) {
    const [fa, fb] = k.split('\n');
    const starts = [...set].map((x) => x.split(',').map(Number)).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const used = new Set();
    for (const [ia, ib] of starts) {
      if (used.has(`${ia},${ib}`)) continue;
      let n = 0;
      while (set.has(`${ia + n + 1},${ib + n + 1}`)) { n++; used.add(`${ia + n},${ib + n}`); }
      const la = lines.get(fa), lb = lines.get(fb), len = W + n;
      blocks.push({
        a: { file: fa, from: la[ia].line, to: la[ia + len - 1].line },
        b: { file: fb, from: lb[ib].line, to: lb[ib + len - 1].line },
        lines: len,
      });
    }
  }
  return blocks.sort((x, y) => y.lines - x.lines);
}

// ---------- the scan ----------

export function scanCode(db, cfg = loadProject(db)) {
  const root = db.root, code = cfg.code;
  const files = listFiles(root, code);
  const known = new Set(files);
  const commits = lastCommits(root);
  const dirty = dirtyFiles(root);
  const isEntry = anyGlob(code.entries);
  const texts = new Map();
  const out = {};
  for (const f of files) {
    const buf = fs.readFileSync(path.join(root, f));
    const text = buf.toString('utf8');
    texts.set(f, text);
    const imports = importsOf(text).map((s) => resolveImport(f, s, known)).filter(Boolean);
    out[f] = {
      path: f,
      area: areaOf(cfg, f),
      lines: text.split('\n').length,
      hash: blobHash(buf),
      commit: commits.get(f)?.commit ?? null,
      date: commits.get(f)?.date ?? null,
      dirty: dirty.has(f),
      entry: isEntry(f),
      imports: [...new Set(imports)],
      importers: [],
      dups: [],
      patterns: [],
    };
  }
  for (const f of files) for (const i of out[f].imports) out[i]?.importers.push(f);
  for (const f of files) out[f].orphan = !out[f].entry && !out[f].importers.length && /\.(m?[jt]sx?)$/.test(f);

  const dups = findDuplicates(texts, code.dup);
  dups.forEach((d, n) => {
    d.id = n + 1;
    out[d.a.file].dups.push({ id: d.id, at: [d.a.from, d.a.to], with: d.b.file, there: [d.b.from, d.b.to], lines: d.lines });
    if (d.b.file !== d.a.file) out[d.b.file].dups.push({ id: d.id, at: [d.b.from, d.b.to], with: d.a.file, there: [d.a.from, d.a.to], lines: d.lines });
  });

  // project patterns: a construct allowed in at most `max` places (or only in `allow`)
  const patterns = code.patterns.map((p) => {
    const re = new RegExp(p.re, 'g');
    const allow = anyGlob(p.allow ?? []);
    const hits = [];
    for (const [f, text] of texts) {
      text.split('\n').forEach((l, i) => { re.lastIndex = 0; if (re.test(l)) hits.push({ file: f, line: i + 1 }); });
    }
    const bad = hits.filter((h) => !allow(h.file));
    const over = p.allow ? bad : hits.length > (p.max ?? Infinity) ? hits : [];
    for (const h of over) out[h.file].patterns.push({ id: p.id, line: h.line, message: p.message ?? p.id });
    return { id: p.id, message: p.message ?? p.id, hits, violations: over };
  });

  return { at: L.now(), head: L.gitHead(root) ?? null, files: out, dups, patterns };
}

// ---------- the guardians' check (references/guardians.md) ----------
// A project with guardians may name its own check (project.json guardians.check: a command that
// prints its marks as JSON): every file marked by every guardian — its owner's, clean, or broken with
// the rule, the line and why (a known violation: debt, with the task that closes it). It may be slow
// (it reads the code's meaning): its result is kept in .tasks/.cache/ under a key of the code it read
// (the scanned files' hashes, project.json, the charters) and run again only when that changes.
// mode: 'run' (run it when the kept one is stale), 'cache' (the kept one, marked stale if it is: the
// admin), 'off'.
const CACHE = '.cache';
export function guardianState(db, scan, mode = 'run') {
  const gcfg = L.guardiansConfig(db);
  if (!gcfg) return null;
  const list = L.loadGuardians(db).map(({ id, name, pillar, file, summary, problems }) => ({ id, name, pillar, file, summary, problems }));
  const out = { list, check: gcfg.check, at: null, head: null, stale: false, ran: false, error: null, errors: [], files: {} };
  if (!gcfg.check || mode === 'off') return out;
  const h = crypto.createHash('sha1').update(gcfg.check).update(fs.readFileSync(path.join(db.dir, PROJECT)));
  for (const f of Object.values(scan.files).sort((a, b) => (a.path < b.path ? -1 : 1))) h.update(`${f.path}:${f.hash}\n`);
  for (const g of L.loadGuardians(db)) h.update(g.text);
  const key = h.digest('hex');
  const dir = path.join(db.dir, CACHE), file = path.join(dir, 'guardians.json');
  let kept = null;
  try { kept = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let res = kept?.key === key ? kept : null;
  if (!res && mode === 'run') {
    const r = spawnSync(gcfg.check, { shell: true, cwd: db.root, encoding: 'utf8', maxBuffer: 512 << 20, timeout: 900e3 });
    let data = null;
    try { data = JSON.parse(r.stdout); } catch {}
    if (!data?.files) return { ...out, error: `\`${gcfg.check}\` gave no marks (exit ${r.status}${r.error ? ', ' + r.error.message : ''}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-5).join(' | ')}` };
    res = { key, at: L.now(), head: L.gitHead(db.root) ?? null, files: data.files, errors: data.errors ?? [], guardians: data.guardians ?? [] };
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
    fs.writeFileSync(file, JSON.stringify(res));
    out.ran = true;
  } else if (!res && kept) res = { ...kept, stale: true };
  if (!res) return { ...out, stale: true };
  const known = new Set(list.map((g) => g.id));
  const unknown = [...new Set(Object.values(res.files).flatMap((m) => Object.keys(m)))].filter((id) => !known.has(id));
  return { ...out, at: res.at, head: res.head, stale: !!res.stale, files: res.files, errors: [...res.errors, ...unknown.map((id) => `the check marks for "${id}", a guardian with no charter in ${gcfg.charters}/`)] };
}
const nameOf = (G, id) => G.list.find((g) => g.id === id)?.name ?? id;
export const guardianText = (G, id, v) => `«${nameOf(G, id)}» ${v.rule} (стр. ${v.line}${v.where ? `, ${v.where}` : ''}): ${v.title ?? ''}${v.message ? ` — ${v.message}` : ''}${v.debt ? ` [долг${v.debt.task ? ' ' + v.debt.task : ', без задачи'}${v.debt.why ? ': ' + v.debt.why : ''}]` : ''}`;
// a file's marks in one line: «Кадр» ✓, «Позы» владелец, «X» ✗ 2 (1 долг)
export function guardianMarks(G, marks) {
  if (!G || !marks) return '';
  const at = (id) => { const i = G.list.findIndex((g) => g.id === id); return i < 0 ? 1e9 : i; };
  return Object.entries(marks).sort(([a], [b]) => at(a) - at(b)).map(([id, m]) => {
    const old = m.stale ? ' (устарело: файл изменён после обхода)' : '';
    if (m.mark === 'home') return `«${nameOf(G, id)}» владелец${old}`;
    if (m.mark !== 'broken') return `«${nameOf(G, id)}» ✓${old}`;
    if (m.findings) return `«${nameOf(G, id)}» ✗ ${m.findings.length}${old}`; // a sweep's mark: its open findings on the file
    const debt = m.violations.filter((v) => v.debt).length;
    return `«${nameOf(G, id)}» ✗ ${m.violations.length}${debt ? ` (${debt === m.violations.length ? 'долг' : `${debt} долг`})` : ''}`;
  }).join(', ');
}

// What the auditor is told of the guardians: who owns which zone (their charters' summaries), what
// their check says per file (below, with the files), and that a finding in a zone goes to its guardian.
function guardiansForAuditor(G, ids) {
  const state = G.error ? `The guardians' check failed: ${G.error}` : G.stale ? `The guardians' marks below are from ${G.at ?? 'an earlier run'} (${G.head ?? '—'}); the code changed since: run \`${G.check}\` yourself where it matters.` : G.check ? `The marks below come from the guardians' check (\`${G.check}\`, ${G.at ?? '—'}).` : 'The project has no automatic guardians\' check: judge the zones by reading. A file\'s `guardians:` line, where there is one, is what each guardian marked on it when it read the whole project (its sweep, on the user\'s request): "(устарело)" when the file changed since; its open findings are listed with the open findings below.';
  const list = G.list.map((g) => `## «${g.name}» (\`${g.id}\`${g.pillar ? `, pillar ${g.pillar}` : ''}; charter: ${g.file})\n\n${g.summary || '—'}`).join('\n\n');
  return `# The guardians: owners of zones (judge every change against each of them)

A guardian owns a zone: how one thing is done right anywhere in the project, through one common place
(its owner's code and doors), not a set of files. A change anywhere in the code may fall in a zone: it
does that thing past the common place, breaks a rule of the charter, or does it in a way you think its
guardian would not take. Go through the list below for every change in scope.
- When something falls in a guardian's zone, read its charter in full and write a finding with
  \`"guardian": "<id>"\` and \`"tasks": ["<id>", …]\` (the tasks of this audit it belongs to). It goes to that guardian for a detailed review; ${ids.length ? 'a task is done only when every guardian called on its findings accepts (a finding with no "tasks" is placed by its files, or holds every task of the audit).' : 'it decides how it is done right.'}
- A file the check marks ✗ is a violation by the check: a new one is a finding (with its guardian), a
  known one (debt) is a finding only when the change made it worse or the debt has no task.
- Do not decide how the common place should grow: that is its guardian's decision. Say what is wrong.
${state}

${list}${G.errors.length ? `\n\nThe check's own errors (each one is a finding: the guardian is blind or out of date):\n${G.errors.map((e) => `- ${e}`).join('\n')}` : ''}`;
}

// ---------- audits × scan → state ----------

const findingFiles = (f) => (f.files ?? []).map((x) => String(x).replace(/:\d+(-\d+)?$/, ''));

export function findings(db, audits = L.loadAudits(db)) {
  const tasks = L.loadAll(db).tasks;
  const resolvedBy = new Map();
  for (const a of audits) for (const r of a.resolves ?? []) resolvedBy.set(r, a.id);
  const out = [];
  for (const a of audits) (a.findings ?? []).forEach((f, i) => {
    const id = `${a.id}#${i + 1}`;
    const task = tasks.find((t) => t.fields.origin === id);
    // a finding closes with its task done, or cancelled as a decision not to fix it (tag
    // wontfix); a task cancelled for another reason (absorbed by an epic) leaves it open
    // until a later audit resolves it
    const closedTask = task && (task.fields.status === 'done' || (L.isClosed(db, task.fields.status) && task.fields.tags.includes('wontfix')));
    out.push({
      ...f, id, audit: a.id, ts: a.ts,
      task: task?.fields.id ?? null,
      taskStatus: task?.fields.status ?? null,
      open: !resolvedBy.has(id) && !closedTask,
      resolvedBy: resolvedBy.get(id) ?? (closedTask ? task.fields.id : null),
    });
  });
  return out;
}

export function readPillars(db, cfg) {
  const file = path.join(db.dir, cfg.tech.pillars);
  if (!fs.existsSync(file)) return [];
  const { sections } = L.parseBody(fs.readFileSync(file, 'utf8'));
  return sections.map((s) => {
    const m = /^([\w-]+)\s+[—-]\s+(.+)$/.exec(s.name);
    return m ? { id: m[1], title: m[2], text: s.text } : { id: s.name.toLowerCase().replace(/\W+/g, '-'), title: s.name, text: s.text };
  });
}

// A pillar's standing: audits cover different code, so the worst verdict among those no
// later audit supersedes (one covering all of its files), raised by the open findings on it
// (a high one: debt; a medium one: at least a risk). The note is the worst verdict's.
const RANK = { ok: 0, risk: 1, debt: 2 };
function pillarVerdict(audits, v, open) {
  if (!v.length && !open.length) return null;
  const files = (a) => Object.keys(a.files ?? {});
  const current = v.filter((x) => {
    const a = audits.find((y) => y.id === x.audit), fs = files(a);
    return !audits.some((b) => b.ts > a.ts && fs.length && fs.every((f) => b.files?.[f]));
  });
  const worst = current.reduce((w, x) => (!w || RANK[x.status] > RANK[w.status] ? x : w), null);
  const raised = open.some((x) => x.severity === 'high') ? 'debt' : open.some((x) => x.severity !== 'low') ? 'risk' : 'ok';
  const status = RANK[raised] > RANK[worst?.status ?? 'ok'] ? raised : worst?.status ?? 'ok';
  const last = v.at(-1);
  return { ...(worst ?? last ?? {}), status, audit: worst?.audit ?? last?.audit ?? null, ts: last?.ts ?? null, audits: current.map((x) => x.audit) };
}

// One status per file: red (an open finding, a non-ok verdict on this very version, a pattern
// broken, a large copy), stale (never audited or changed since), ok.
export function codeState(db, { guardians = 'run' } = {}) {
  const cfg = loadProject(db);
  const scan = scanCode(db, cfg);
  const G = guardianState(db, scan, guardians);
  const audits = L.loadAudits(db);
  const fnd = findings(db, audits);
  // what each guardian marked on each file when it read the whole project (its sweeps), over its check's
  if (G) for (const [p, ms] of Object.entries(sweepMarks(audits, scan, fnd))) G.files[p] = { ...(G.files[p] ?? {}), ...ms };
  const files = {};
  for (const f of Object.values(scan.files)) {
    const verdicts = audits.filter((a) => a.files?.[f.path]).map((a) => ({ audit: a.id, ts: a.ts, ...a.files[f.path] }));
    const last = verdicts.at(-1) ?? null;
    const open = fnd.filter((x) => x.open && findingFiles(x).includes(f.path));
    const reasons = [];
    for (const x of open) reasons.push({ kind: x.kind, text: x.guardian && G ? `«${nameOf(G, x.guardian)}»: ${x.title ?? x.text}` : x.title ?? x.text, ref: x.id, task: x.task, severity: x.severity ?? 'medium', guardian: x.guardian });
    if (last && last.status !== 'ok' && last.hash === f.hash) reasons.push({ kind: last.status, text: last.notes ?? '', ref: last.audit });
    for (const p of f.patterns) reasons.push({ kind: 'pattern', text: `${p.message} (стр. ${p.line})`, ref: p.id });
    for (const d of f.dups.filter((d) => d.lines >= cfg.code.dup.red_lines)) reasons.push({ kind: 'duplicate', text: `${d.lines} строк совпадают с ${d.with}:${d.there[0]}-${d.there[1]} (стр. ${d.at[0]}-${d.at[1]})`, ref: `dup#${d.id}` });
    // a guardian's ✗: a door of its owner opened past it (red; a known one is debt with its task)
    const guards = G?.files[f.path] ?? null;
    for (const [id, m] of Object.entries(guards ?? {})) for (const v of m.violations ?? []) reasons.push({ kind: 'guardian', text: guardianText(G, id, v), ref: `${id}:${v.rule}`, task: v.debt?.task ?? null, guardian: id });
    const fresh = last && last.hash === f.hash;
    // red: anything but low findings (a pattern, a big copy, a non-ok verdict count as red);
    // minor: only low findings, worth fixing when nearby
    const serious = reasons.some((r) => r.severity !== 'low');
    files[f.path] = {
      ...f,
      status: serious ? 'red' : reasons.length ? 'minor' : fresh ? 'ok' : 'stale',
      reasons,
      audit: last,
      verdicts,
      changedSinceAudit: !!last && last.hash !== f.hash,
      guards,
    };
  }
  const pillars = readPillars(db, cfg).map((p) => {
    const v = audits.filter((a) => a.pillars?.[p.id]).map((a) => ({ audit: a.id, ts: a.ts, ...a.pillars[p.id] }));
    const open = fnd.filter((x) => x.open && x.pillar === p.id);
    return { ...p, verdict: pillarVerdict(audits, v, open), history: v, open: open.map((x) => x.id) };
  });
  const list = Object.values(files);
  return {
    project: cfg.name,
    at: scan.at,
    head: scan.head,
    areas: cfg.code.areas,
    summary: {
      files: list.length,
      lines: list.reduce((s, f) => s + f.lines, 0),
      red: list.filter((f) => f.status === 'red').length,
      minor: list.filter((f) => f.status === 'minor').length,
      stale: list.filter((f) => f.status === 'stale').length,
      ok: list.filter((f) => f.status === 'ok').length,
      openFindings: fnd.filter((x) => x.open).length,
      dups: scan.dups.length,
      dupRed: cfg.code.dup.red_lines,
      orphans: list.filter((f) => f.orphan).length,
      lastAudit: audits.at(-1)?.ts ?? null,
    },
    guardians: G && {
      ...G, files: undefined,
      list: G.list.map((g) => {
        const ms = Object.values(G.files).map((x) => x[g.id]).filter(Boolean);
        const vs = ms.flatMap((m) => m.violations ?? []);
        const sw = list.map((f) => G.files[f.path]?.[g.id]).filter((m) => m?.audit);
        const mine = fnd.filter((x) => x.open && x.guardian === g.id);
        return { ...g, broken: ms.filter((m) => m.mark === 'broken').length, violations: vs.length, debt: vs.filter((v) => v.debt).length,
          sweep: { files: list.length, read: sw.filter((m) => !m.stale).length, stale: sw.filter((m) => m.stale).length, broken: sw.filter((m) => m.mark === 'broken' && !m.stale).length, findings: mine.length, filed: mine.filter((x) => x.task).length, last: sw.reduce((t, m) => (m.ts > t ? m.ts : t), '') || null } };
      }),
    },
    files,
    dups: scan.dups,
    patterns: scan.patterns,
    findings: fnd,
    pillars,
    audits: audits.map((a) => ({ id: a.id, ts: a.ts, title: a.title, auditor: a.auditor, guardian: a.guardian, summary: a.summary, tasks: a.tasks ?? {}, files: Object.keys(a.files ?? a.marks ?? {}).length, findings: (a.findings ?? []).length, resolves: a.resolves ?? [] })),
  };
}

// ---------- recording an audit ----------

export function checkAudit(a) {
  const errs = [];
  if (!a || typeof a !== 'object') return ['the audit must be a JSON object'];
  if (!String(a.title ?? '').trim()) errs.push('"title" is required');
  if (!String(a.summary ?? '').trim()) errs.push('"summary" is required');
  for (const [id, v] of Object.entries(a.tasks ?? {})) if (!['pass', 'fail'].includes(v?.verdict)) errs.push(`tasks.${id}.verdict must be pass|fail`);
  for (const [f, v] of Object.entries(a.files ?? {})) if (!FILE_STATUS.includes(v?.status)) errs.push(`files["${f}"].status must be one of ${FILE_STATUS.join('|')}`);
  for (const [p, v] of Object.entries(a.pillars ?? {})) if (!PILLAR_STATUS.includes(v?.status)) errs.push(`pillars.${p}.status must be one of ${PILLAR_STATUS.join('|')}`);
  (a.findings ?? []).forEach((f, i) => {
    if (!FINDING_KINDS.includes(f.kind)) errs.push(`findings[${i}].kind must be one of ${FINDING_KINDS.join('|')}`);
    if (!String(f.title ?? '').trim() || !String(f.text ?? '').trim()) errs.push(`findings[${i}] needs title and text`);
    if (!Array.isArray(f.files) || !f.files.length) errs.push(`findings[${i}].files must list the files (path or path:from-to)`);
  });
  return errs;
}

// The verdict goes in as the auditor wrote it; the tracker only stamps when, which session,
// which commit and the hash of every judged file (so a later edit shows the verdict is stale).
export function addAudit(db, a) {
  if (a?.marks) throw new L.TaskError('audit rejected: a verdict with "marks" is a guardian\'s sweep: tasks guardian sweep add --file …');
  const errs = checkAudit(a);
  if (errs.length) throw new L.TaskError('audit rejected:\n  ' + errs.join('\n  '));
  for (const id of Object.keys(a.tasks ?? {})) if (!L.exists(db, id)) throw new L.TaskError(`audit: task ${id} not found`);
  const gs = L.loadGuardians(db);
  (a.findings ?? []).forEach((f, i) => { if (f.guardian != null && !gs.some((g) => g.id === f.guardian)) throw new L.TaskError(`audit rejected: findings[${i}].guardian "${f.guardian}" is not a guardian of the project (${gs.map((g) => g.id).join(', ') || 'none'})`); });
  const rec = { id: null, ts: L.now(), session: L.sessionId() ?? null, head: L.gitHead(db.root) ?? null, ...a };
  for (const [f, v] of Object.entries(rec.files ?? {})) {
    const abs = path.join(db.root, f);
    v.hash = fs.existsSync(abs) ? blobHash(fs.readFileSync(abs)) : null;
  }
  return L.saveAudit(db, rec);
}

// ---------- the brief an auditor works from ----------

// Files the tasks' work changed: each task's own stretches of work (L.workRanges) since its last
// audit (a new audit judges the work done after the last verdict), the code read as it is now
export function taskFiles(db, ids) {
  const audits = L.loadAudits(db);
  const ranges = {}, files = new Set();
  for (const id of ids) {
    const after = audits.filter((a) => a.tasks?.[id]).at(-1)?.ts ?? '';
    ranges[id] = L.workRanges(db, id).filter((r) => r.at > after);
    for (const f of L.workFiles(db, id, { after })) files.add(f);
  }
  return { ranges, files: [...files].sort() };
}

// The pillars a scope touches, in full; the others by their heading line only
function pickPillars(text, scope, open, file) {
  const [head, ...secs] = text.split(/^(?=## )/m);
  const named = new Set(open.map((x) => x.pillar).filter(Boolean));
  const keys = scope.flatMap((f) => [f, ...(/^index\.|^main\./.test(path.basename(f)) ? [] : ['`' + path.basename(f)])]);
  const full = [], brief = [];
  for (const sec of secs) {
    const id = sec.match(/^## (\S+)/)?.[1];
    (named.has(id) || keys.some((k) => sec.includes(k)) ? full : brief).push(sec.trimEnd());
  }
  return [head.trim(), ...full, brief.length && `## Other pillars (read them in ${file} when the code in scope touches them)\n\n${brief.map((x) => '- ' + x.split('\n')[0].replace(/^## /, '')).join('\n')}`].filter(Boolean).join('\n\n');
}

// Everything an auditor with no memory of the work needs, and nothing of how the authors
// judged it themselves: what was asked and agreed (Description, Decision, Acceptance), the
// code, the project's pillars and checks, what the scanner sees and the findings still open.
// Not given: Plan, Notes, Result — the authors' own account would anchor the verdict.
// onlyFiles: the scope is `files` alone (an audit by area that also judges the tasks whose
// work lies there), not every file the tasks changed
// since: the scope is the code changed since that git ref (an incremental audit of a batch of
// work); the importers of those files are listed as context, not as scope.
// allPillars: every pillar in full; by default only the pillars the scope touches (named in a
// pillar's text, or by an open finding on the scope) are given in full, the rest by title
export function auditBrief(db, { tasks = [], files = [], title = '', out = '', onlyFiles = false, since = '', allPillars = false } = {}) {
  const cfg = loadProject(db);
  const state = codeState(db);
  const ids = tasks.map((t) => L.normId(db, t));
  const fromTasks = ids.length && !onlyFiles ? taskFiles(db, ids) : { ranges: {}, files: [] };
  // the code the scan covers, the wiki and the guardians' charters; the tracker's own files are not under audit
  const wiki = cfg.wiki?.dir ? cfg.wiki.dir.replace(/\/?$/, '/') : null;
  const changed = since ? git(db.root, 'diff', '--name-only', since).stdout.split('\n').filter(Boolean) : [];
  const charters = new Set(L.loadGuardians(db).map((g) => g.file)); // a guardian's charter is the project's, under audit too
  const scope = [...new Set([...fromTasks.files, ...files, ...changed])]
    .filter((f) => state.files[f] || (wiki && f.startsWith(wiki) && fs.existsSync(path.join(db.root, f))) || charters.has(f) || files.includes(f)).sort();
  const read = (rel) => { const p = path.join(db.dir, rel); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : ''; };
  const tpl = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'templates', 'auditor.md'), 'utf8');
  const parts = [tpl.trim()];
  parts.push(`# This audit\n\n${title || (ids.length ? `Tasks ${ids.join(', ')}` : 'Code audit')}\nProject root: ${db.root}\nCommit: ${state.head ?? '—'}${Object.keys(fromTasks.ranges).length ? `\nThe tasks' work (the files changed in these stretches are the scope; judge the code as it is now): ${Object.entries(fromTasks.ranges).map(([id, rs]) => `${id} ${rs.map((r) => `${r.from}..${r.to ?? 'working tree'}`).join(', ') || 'no work since its last audit'}`).join('; ')}` : ''}\nWrite your verdict as JSON to: ${out || '<path given by the caller>'}`);
  const pillars = read(cfg.tech.pillars), checks = read(cfg.tech.checks);
  const open = state.findings.filter((x) => x.open && (x.files ?? []).some((p) => scope.includes(String(p).replace(/:\d+(-\d+)?$/, ''))));
  // the scanner's rules (fenced json) are the scanner's: their hits come per file below
  const prose = pillars.replace(/```json\n[\s\S]*?```\n?/g, '');
  if (pillars) parts.push(`# The project's pillars (judge every change against these)\n\n${allPillars ? prose : pickPillars(prose, scope, open, path.join('.tasks', cfg.tech.pillars))}`);
  if (checks) parts.push(`# The project's checks (known problems to look for)\n\n${checks}`);
  const G = state.guardians;
  if (G?.list.length) parts.push(guardiansForAuditor(G, ids));
  for (const id of ids) {
    const t = L.loadTask(db, id);
    const sec = (n) => L.sectionText(t, n).trim();
    parts.push([`# Task ${id}: ${t.fields.title}`, `Type ${t.fields.type}, size ${t.fields.size ?? '—'}`,
      `## What the user asked (verbatim)\n\n${sec('Description') || '—'}`,
      sec('Decision') && `## The agreed solution\n\n${sec('Decision')}`,
      sec('Acceptance criteria') && `## Acceptance criteria\n\n${sec('Acceptance criteria')}`,
      G?.list.length && sec(L.GUARDIANS) && `## What the guardians said at grooming (part of the agreed solution)\n\n${sec(L.GUARDIANS).replace(/^### /gm, '### Guardian ')}`].filter(Boolean).join('\n\n'));
  }
  const lines = scope.map((f) => {
    const s = state.files[f];
    if (!s) return `- ${f}`;
    const sig = [
      s.orphan && 'nobody imports it',
      ...s.dups.map((d) => `${d.lines} lines (${d.at.join('-')}) identical to ${d.with}:${d.there.join('-')}`),
      ...s.patterns.map((p) => `${p.message} at line ${p.line}`),
    ].filter(Boolean);
    const broken = Object.entries(s.guards ?? {}).flatMap(([id, m]) => (m.violations ?? []).map((v) => guardianText(G, id, v)));
    const marks = s.guards ? `\n  guardians: ${guardianMarks(G, s.guards)}${broken.map((x) => `\n    ✗ ${x}`).join('')}` : '';
    return `- ${f} (${s.lines} lines${s.audit ? `, last audited ${s.audit.ts.slice(0, 10)} as ${s.audit.status}${s.changedSinceAudit ? ', changed since' : ''}` : ', never audited'})${sig.length ? '\n  scanner: ' + sig.join('; ') : ''}${marks}`;
  });
  parts.push(`# Files in scope (${scope.length})\n\nRead every one of them; follow imports and importers where a judgement needs it.\n\n${lines.join('\n') || '—'}`);
  if (since) {
    const callers = [...new Set(scope.flatMap((f) => state.files[f]?.importers ?? []))].filter((f) => !scope.includes(f)).sort();
    if (callers.length) parts.push(`# Callers of the changed files (context, not scope)\n\nRead the parts that use the changed code; judge them only where the change breaks or duplicates something.\n\n${callers.map((f) => `- ${f}`).join('\n')}`);
  }
  if (open.length) parts.push(`# Findings still open on these files\n\nIf the code now fixes one, list its id in "resolves".\n\n${open.map((x) => `- ${x.id} [${x.kind}] ${x.title}: ${x.text} (${x.files.join(', ')})`).join('\n')}`);
  return { text: parts.join('\n\n---\n\n') + '\n', scope, tasks: ids };
}

// ---------- the guardians' briefs: grooming and a detailed review ----------

const template = (name) => fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'templates', name), 'utf8').trim();
const userWords = (t) => L.sectionText(t, 'Notes').split('\n').filter((l) => /· user:/.test(l)).join('\n');

// Grooming: one guardian asked about one task (a fresh agent each): its charter, the task as the
// user asked it and the solution drafted so far; it answers that it is not its zone, or how the thing
// is done right in its zone and how its common place grows, if it must.
export function guardianGroomBrief(db, gid, taskId, { draft = '', out = '' } = {}) {
  const g = L.guardianOf(db, gid) ?? (() => { throw new L.TaskError(`no guardian "${gid}" (tasks guardian list)`); })();
  const t = L.loadTask(db, L.normId(db, taskId));
  const sec = (n) => L.sectionText(t, n).trim();
  const decision = draft || sec('Decision');
  const said = L.guardianSays(t, L.GUARDIANS, L.loadGuardians(db)).find((s) => s.guardian === g.id);
  const parts = [template('guardian-groom.md').replaceAll('{{name}}', g.name)];
  parts.push(`# This request\n\nProject root: ${db.root}\nCommit: ${L.gitHead(db.root) ?? '—'}\nWrite your answer (markdown) to: ${out || '<path given by the caller>'}`);
  parts.push(`# Your charter (${g.file})\n\n${g.text.replace(/^---[\s\S]*?---\s*/, '').trim()}`);
  parts.push([`# Task ${t.fields.id}: ${t.fields.title}`, `Type ${t.fields.type}, size ${t.fields.size ?? '—'}`,
    `## What the user asked (verbatim)\n\n${sec('Description') || '—'}`,
    userWords(t) && `## The user's later words\n\n${userWords(t)}`,
    `## The solution drafted so far\n\n${decision || '— (none yet: judge from the request)'}`,
    said && `## What you said on it before (answer again in full: it replaces this)\n\n${said.text}`].filter(Boolean).join('\n\n'));
  return { text: parts.join('\n\n---\n\n') + '\n', guardian: g.id, task: t.fields.id };
}

// Arch QA: a finding the auditor put in a guardian's zone, for that guardian's detailed review (a
// fresh agent): its charter, the finding, the tasks of the audit (what was asked, agreed, and what it
// said at grooming) and its check's marks on the finding's files.
export function guardianReviewBrief(db, findingId, { out = '' } = {}) {
  const id = String(findingId).toUpperCase();
  const f = findings(db).find((x) => x.id === id) ?? (() => { throw new L.TaskError(`finding ${findingId} not found (A-0001#2)`); })();
  if (!f.guardian) throw new L.TaskError(`${id} is in no guardian's zone (the auditor set no "guardian")`);
  const g = L.guardianOf(db, f.guardian) ?? (() => { throw new L.TaskError(`${id}: no guardian "${f.guardian}" in the project`); })();
  const a = L.loadAudits(db).find((x) => x.id === f.audit);
  if (isSweep(a)) throw new L.TaskError(`${id} is «${g.name}»'s own finding from its sweep of the project: nothing to review, file it as a task (tasks audit task ${id})`);
  const state = codeState(db);
  const parts = [template('guardian-review.md').replaceAll('{{name}}', g.name)];
  parts.push(`# This review\n\nProject root: ${db.root}\nCommit: ${state.head ?? '—'} (the audit read ${a.head ?? '—'})\nWrite your verdict as JSON to: ${out || '<path given by the caller>'}\nThe finding: ${id}; you: "${g.id}"`);
  parts.push(`# Your charter (${g.file})\n\n${g.text.replace(/^---[\s\S]*?---\s*/, '').trim()}`);
  parts.push(`# The finding ${id} (audit «${a.title}»)\n\nKind ${f.kind}, severity ${f.severity ?? 'medium'}${f.pillar ? `, pillar ${f.pillar}` : ''}\n\n## ${f.title}\n\n${f.text}\n\nWhat the auditor would do: ${f.fix ?? '—'}\n\nWhere: ${(f.files ?? []).map((x) => '`' + x + '`').join(', ')}`);
  for (const tid of Object.keys(a.tasks ?? {})) {
    if (!L.exists(db, tid)) continue;
    const t = L.loadTask(db, tid);
    const sec = (n) => L.sectionText(t, n).trim();
    const said = L.guardianSays(t, L.GUARDIANS, L.loadGuardians(db)).find((s) => s.guardian === g.id);
    parts.push([`# Task ${tid}: ${t.fields.title}`, `## What the user asked (verbatim)\n\n${sec('Description') || '—'}`,
      sec('Decision') && `## The agreed solution\n\n${sec('Decision')}`,
      said && `## What you said on it at grooming\n\n${said.text}`].filter(Boolean).join('\n\n'));
  }
  const files = [...new Set((f.files ?? []).map((x) => String(x).replace(/:\d+(-\d+)?$/, '')))];
  const marks = files.map((p) => {
    const s = state.files[p];
    const vs = Object.entries(s?.guards ?? {}).flatMap(([gid2, m]) => (m.violations ?? []).map((v) => guardianText(state.guardians, gid2, v)));
    return `- ${p}${s?.guards ? `: ${guardianMarks(state.guardians, s.guards)}` : ''}${vs.map((x) => `\n    ✗ ${x}`).join('')}`;
  });
  parts.push(`# The guardians' check on these files\n\n${marks.join('\n') || '—'}`);
  return { text: parts.join('\n\n---\n\n') + '\n', guardian: g.id, finding: id };
}

// ---------- the guardians' sweep: the audit of the whole project, by every guardian ----------
// On the user's request every guardian of the project reads every file of the code, one by one, for
// its own zone (a fresh agent per batch of files: its charter and the batch). Its verdict marks each
// file — home (its common place), clean, or broken with a finding per violation: why, and how it is
// done right through the common place — and goes in as written, an audit record with "guardian" and
// "marks" beside the others (A-0001.json): its findings are filed as tasks like any audit's (tasks
// audit task), a mark holds for the version of the file it was written on (its hash). Nothing here
// judges the code: the marks are the guardian's.
export const SWEEP_MARKS = ['home', 'clean', 'broken'];
export const SWEEP_LINES = 8000; // a batch: what one agent reads in full and still judges well
export const isSweep = (a) => !!(a?.guardian && a?.marks);

// path → guardian → its latest mark: { mark, notes, audit, ts, hash, stale, findings (its open ones there) }
function sweepMarks(audits, scan, fnd) {
  const out = {};
  for (const a of audits) if (isSweep(a)) for (const [p, m] of Object.entries(a.marks)) (out[p] ??= {})[a.guardian] = { mark: m.mark, notes: m.notes ?? null, audit: a.id, ts: a.ts, hash: m.hash ?? null };
  for (const [p, ms] of Object.entries(out)) for (const [gid, m] of Object.entries(ms)) {
    m.stale = !scan.files[p] || m.hash !== scan.files[p].hash;
    m.findings = fnd.filter((x) => x.open && x.guardian === gid && findingFiles(x).includes(p)).map((x) => x.id);
    m.violations = [];
  }
  return out;
}

// The batches of a sweep, per guardian: the scanned files (or an area's, or the ones named), in the
// order of the project's areas and by path, packed up to `lines` lines a batch (a bigger file alone).
// rest: only the files the guardian has no mark on for their current version (never read, changed since).
export function sweepPlan(db, { guardians = [], rest = false, lines = SWEEP_LINES, area = '', files = [] } = {}) {
  const gs = L.loadGuardians(db);
  if (!gs.length) throw new L.TaskError('the project has no guardians (project.json "guardians": references/guardians.md)');
  const pick = guardians.length ? guardians.map((x) => L.guardianOf(db, x) ?? (() => { throw new L.TaskError(`no guardian "${x}" (tasks guardian list)`); })()) : gs;
  const cfg = loadProject(db);
  const state = codeState(db, { guardians: 'cache' });
  if (area && !cfg.code.areas.some((a) => a.id === area)) throw new L.TaskError(`no area "${area}" in project.json code.areas (${cfg.code.areas.map((a) => a.id).join(', ') || 'none'})`);
  for (const f of files) if (!state.files[f]) throw new L.TaskError(`${f} is not in the scanned code (.tasks/project.json code)`);
  const order = (p) => { const i = cfg.code.areas.findIndex((a) => a.id === state.files[p].area); return i < 0 ? 1e9 : i; };
  const all = Object.keys(state.files).filter((p) => (!area || state.files[p].area === area) && (!files.length || files.includes(p)))
    .sort((a, b) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0));
  return {
    state, lines,
    guardians: pick.map((g) => {
      const read = (p) => { const m = state.files[p].guards?.[g.id]; return !!m?.audit && !m.stale; };
      const batches = [];
      let cur = null;
      for (const p of all.filter((x) => !rest || !read(x))) {
        if (!cur || (cur.files.length && cur.lines + state.files[p].lines > lines)) batches.push(cur = { files: [], lines: 0 });
        cur.files.push(p);
        cur.lines += state.files[p].lines;
      }
      batches.forEach((b, i) => { b.k = i + 1; b.of = batches.length; b.areas = [...new Set(b.files.map((p) => state.files[p].area ?? '—'))]; });
      return { g, batches };
    }),
  };
}

function sweepBrief(db, state, g, b, verdict) {
  const title = `«${g.name}»: аудит всего проекта, пачка ${b.k}/${b.of}`;
  const open = state.findings.filter((x) => x.open && x.guardian === g.id && findingFiles(x).some((p) => b.files.includes(p)));
  const parts = [template('guardian-sweep.md').replaceAll('{{name}}', g.name)];
  parts.push(`# This batch\n\nProject root: ${db.root}\nCommit: ${state.head ?? '—'}\nYou: "${g.id}"; the batch: "${b.k}/${b.of}"; the title: "${title}"\nWrite your verdict as JSON to: ${verdict}`);
  parts.push(`# Your charter (${g.file})\n\n${g.text.replace(/^---[\s\S]*?---\s*/, '').trim()}`);
  parts.push(`# Your findings still open on these files\n\n${open.map((x) => `- ${x.id} [${x.kind}, ${x.severity ?? 'medium'}] ${x.title}: ${x.text} (${x.files.join(', ')})${x.task ? ` → ${x.task}` : ''}`).join('\n') || '— none'}`);
  parts.push(`# The files of this batch (${b.files.length} files, ${b.lines} lines)\n\nRead them one by one, in this order, each in full; mark every one.\n\n${b.files.map((p) => `- ${p} (${state.files[p].lines} lines${state.files[p].area ? `, area ${state.files[p].area}` : ''})`).join('\n')}`);
  return parts.join('\n\n---\n\n') + '\n';
}

// Every batch's brief into `dir` (<guardian>-<k>.md, its verdict to <guardian>-<k>.json) and the
// batches' files (sweep.json: on add, a file of the batch left unmarked is named)
export function sweepBriefs(db, opts, dir) {
  const plan = sweepPlan(db, opts);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { at: L.now(), head: plan.state.head ?? null, lines: plan.lines, batches: {} };
  const out = [];
  for (const { g, batches } of plan.guardians) for (const b of batches) {
    const name = `${g.id}-${b.k}`, brief = path.join(dir, `${name}.md`), verdict = path.join(dir, `${name}.json`);
    fs.writeFileSync(brief, sweepBrief(db, plan.state, g, b, verdict));
    manifest.batches[name] = { guardian: g.id, batch: `${b.k}/${b.of}`, files: b.files };
    out.push({ guardian: g.id, name: g.name, k: b.k, of: b.of, brief, verdict, files: b.files.length, lines: b.lines, areas: b.areas });
  }
  fs.writeFileSync(path.join(dir, 'sweep.json'), JSON.stringify(manifest, null, 2) + '\n');
  return out;
}

// A guardian's sweep verdict, as it wrote it: checked for form only (every mark one of the three, a
// broken file with its finding, a finding in the guardian's own zone with how it is done right), then
// stamped with when, which session, which commit and the hash of every marked file.
export function addSweep(db, r, { batch = null } = {}) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new L.TaskError('sweep rejected: the verdict must be a JSON object');
  const gs = L.loadGuardians(db);
  const g = gs.find((x) => x.id === r.guardian);
  const errs = [];
  if (!g) errs.push(`"guardian" must be the id of a guardian of the project (${gs.map((x) => x.id).join(', ') || 'none'})`);
  if (r.tasks || r.files) errs.push('a sweep has "marks", not "tasks" or "files" (those are the general audit\'s: tasks audit add)');
  errs.push(...checkAudit({ ...r, tasks: undefined, files: undefined }));
  const scan = scanCode(db, loadProject(db));
  const marks = r.marks && typeof r.marks === 'object' && !Array.isArray(r.marks) ? r.marks : {};
  if (!Object.keys(marks).length) errs.push('"marks" must mark every file of the batch: { "src/a.js": { "mark": "clean" } }');
  for (const [p, m] of Object.entries(marks)) {
    if (!scan.files[p]) errs.push(`marks["${p}"]: not a file of the project's code (.tasks/project.json code)`);
    if (!SWEEP_MARKS.includes(m?.mark)) errs.push(`marks["${p}"].mark must be one of ${SWEEP_MARKS.join('|')}`);
  }
  (r.findings ?? []).forEach((f, i) => {
    if (f?.guardian !== r.guardian) errs.push(`findings[${i}].guardian must be "${r.guardian}": a guardian's sweep finds in its own zone`);
    if (!String(f?.fix ?? '').trim()) errs.push(`findings[${i}].fix: how it is done right through the common place`);
    for (const p of findingFiles(f ?? {})) if (!['broken', 'home'].includes(marks[p]?.mark)) errs.push(`findings[${i}]: ${p} must be marked broken (or home) in "marks"`);
  });
  for (const [p, m] of Object.entries(marks)) if (m?.mark === 'broken' && !(r.findings ?? []).some((f) => findingFiles(f ?? {}).includes(p)) && !String(m.notes ?? '').trim()) errs.push(`marks["${p}"] is broken: a finding of this verdict on it, or notes naming its open finding`);
  const open = findings(db).filter((x) => x.open);
  for (const id of r.resolves ?? []) if (!open.some((x) => x.id === id && x.guardian === r.guardian)) errs.push(`resolves: ${id} is not an open finding of «${g?.name ?? r.guardian}»`);
  if (errs.length) throw new L.TaskError('sweep rejected:\n  ' + errs.join('\n  '));
  const rec = { id: null, ts: L.now(), session: L.sessionId() ?? null, head: L.gitHead(db.root) ?? null, ...r };
  for (const [p, m] of Object.entries(rec.marks)) m.hash = scan.files[p].hash;
  L.saveAudit(db, rec);
  return { rec, guardian: g, unmarked: batch ? batch.files.filter((p) => !marks[p]) : [] };
}
