// Storage library for the .tasks/ format (spec: ../references/format.md).
// The one implementation of read/write/validate/transition rules — the CLI (tasks.mjs)
// and any future web UI build on it. No console output and no process.exit here.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const FORMAT = 'task-tracker/1';
export const DIR = '.tasks';
export const FIELD_ORDER = ['id', 'title', 'status', 'type', 'priority', 'size', 'initiative', 'tags', 'parent', 'depends_on', 'assignee', 'docs', 'origin', 'created', 'updated'];
export const REQUIRED = ['id', 'title', 'status', 'type', 'priority', 'created', 'updated'];
export const LIST_FIELDS = ['tags', 'depends_on', 'docs'];
export const SECTIONS = ['Description', 'Acceptance criteria', 'Plan', 'Notes', 'Result'];
// where a section goes when it is first written: the required ones plus the optional
// Decision (the agreed solution: options, pros and cons, why), right after the description
// and the optional Wiki (the draft of the wiki's changes, applied to the wiki only when the task is done)
// and the optional Guardians (what each guardian of the project said at grooming: references/guardians.md)
export const ORDER = ['Description', 'Decision', 'Guardians', 'Acceptance criteria', 'Plan', 'Notes', 'Result', 'Wiki'];
export const AUDITS = 'audits';
export const GATE_KINDS = ['committed', 'section_nonempty', 'checklist_nonempty', 'checklist_complete', 'field_set', 'field_in', 'deps_done', 'children_done', 'note_required', 'by_user', 'attestation', 'command', 'audit', 'guardians_asked'];

export class TaskError extends Error {}

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
export const today = () => now().slice(0, 10);
const norm = (s) => String(s).trim().toLowerCase();
const asList = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);

// ---------- frontmatter: a strict YAML subset, every value is a JSON literal or a bare word ----------

const BARE = /^[A-Za-z_][A-Za-z0-9_.\-/]*$/;
const YAML_WORDS = new Set(['null', 'true', 'false', 'yes', 'no', 'on', 'off', 'y', 'n']);

function scalarOut(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return BARE.test(s) && !YAML_WORDS.has(s.toLowerCase()) ? s : JSON.stringify(s);
}
const valueOut = (v) => (Array.isArray(v) ? `[${v.map(scalarOut).join(', ')}]` : scalarOut(v));

function splitFlow(s) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') cur += s[++i] ?? '';
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") { q = c; cur += c; }
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function valueIn(raw) {
  raw = raw.trim();
  if (raw === '' || raw === '~' || raw === 'null') return null;
  try { return JSON.parse(raw); } catch {}
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    return inner ? splitFlow(inner).map(valueIn) : [];
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

// ---------- task file <-> object ----------

export function parseBody(body) {
  const preamble = [], sections = [];
  let cur = null, fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (h) { cur = { name: h[1], lines: [] }; sections.push(cur); }
    else (cur ? cur.lines : preamble).push(line);
  }
  return {
    preamble: preamble.join('\n').trim(),
    sections: sections.map((s) => ({ name: s.name, text: s.lines.join('\n').trim() })),
  };
}

// a markdown file with a frontmatter (a task, a guardian's charter): its fields and the rest
export function parseFront(text, file = '') {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) throw new TaskError(`${file}: missing frontmatter (--- … ---)`);
  const fields = {};
  m[1].split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const kv = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!kv) throw new TaskError(`${file}: frontmatter line ${i + 2} is not "key: value": ${line}`);
    fields[kv[1]] = valueIn(kv[2] ?? '');
  });
  return { fields, body: text.slice(m[0].length) };
}

export function parseTask(text, file = '') {
  const { fields, body } = parseFront(text, file);
  for (const k of LIST_FIELDS) fields[k] = fields[k] == null ? [] : Array.isArray(fields[k]) ? fields[k].map(String) : [String(fields[k])];
  return { file, fields, ...parseBody(body) };
}

export function renderTask(t) {
  const keys = [...FIELD_ORDER.filter((k) => k in t.fields), ...Object.keys(t.fields).filter((k) => !FIELD_ORDER.includes(k))];
  let out = '---\n' + keys.map((k) => `${k}: ${valueOut(t.fields[k])}`).join('\n') + '\n---\n\n';
  if (t.preamble) out += t.preamble + '\n\n';
  for (const s of t.sections) out += `## ${s.name}\n\n` + (s.text ? s.text + '\n\n' : '');
  return out.trimEnd() + '\n';
}

// ---------- body helpers ----------

export const getSection = (t, name) => t.sections.find((s) => norm(s.name) === norm(name));
export const sectionText = (t, name) => getSection(t, name)?.text ?? '';
export const meaningful = (text) => text.replace(/<!--[\s\S]*?-->/g, '').trim().length > 0;

export function setSection(t, name, text) {
  let s = getSection(t, name);
  if (!s) {
    const canon = ORDER.find((n) => norm(n) === norm(name)) ?? name.trim();
    s = { name: canon, text: '' };
    const rank = ORDER.indexOf(canon);
    const at = rank < 0 ? -1 : t.sections.findIndex((x) => ORDER.indexOf(x.name) > rank);
    if (at < 0) t.sections.push(s); else t.sections.splice(at, 0, s);
  }
  s.text = String(text).trim();
}

const CHECK_RE = /^(\s*[-*] )\[([ xX])\] (.*)$/;
export const checklist = (text) => text.split('\n').map((l) => CHECK_RE.exec(l)).filter(Boolean).map((m) => ({ done: m[2] !== ' ', text: m[3].trim() }));

// nums are 1-based positions among checklist items; done=null removes the items
export function editChecklist(text, nums, done) {
  let n = 0;
  const out = [];
  for (const l of text.split('\n')) {
    const m = CHECK_RE.exec(l);
    if (!m) { out.push(l); continue; }
    n++;
    if (!nums.includes(n)) out.push(l);
    else if (done !== null) out.push(`${m[1]}[${done ? 'x' : ' '}] ${m[3]}`);
  }
  return out.join('\n');
}

// ---------- database ----------

export function findRoot(start = process.cwd()) {
  for (let d = path.resolve(start); ; ) {
    if (fs.existsSync(path.join(d, DIR, 'workflow.json'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export function openDb(root) {
  const dir = path.join(root, DIR);
  const wf = JSON.parse(fs.readFileSync(path.join(dir, 'workflow.json'), 'utf8'));
  if (String(wf.format).split('.')[0] !== FORMAT) throw new TaskError(`workflow.json format "${wf.format}" is not supported (expected ${FORMAT})`);
  return { root, dir, itemsDir: path.join(dir, 'items'), eventsFile: path.join(dir, 'events.jsonl'), wf };
}

export const statusIds = (db) => db.wf.statuses.map((s) => s.id);
export const statusDef = (db, id) => db.wf.statuses.find((s) => s.id === id);
export const isClosed = (db, status) => statusDef(db, status)?.category === 'done';
// sizes: how big a change the task is (workflow.sizes, largest first: {id, title} or a bare id)
export const sizeIds = (db) => (db.wf.sizes ?? []).map((s) => (typeof s === 'string' ? s : s.id));
// initiatives: the project's lines of work, one per task, rows of the board ({id, title, goal?, closed?});
// aspects: tags for a quality that cuts across them (e.g. perf), a filter over every row
export const initiatives = (db) => db.wf.initiatives ?? [];
export const initiativeDef = (db, id) => initiatives(db).find((x) => x.id === id);
export const aspects = (db) => db.wf.aspects ?? [];

// the rows' order, top first: the named initiatives in that order, the rest keep theirs after them
export function orderInitiatives(db, ids) {
  const list = initiatives(db);
  for (const id of ids) if (!initiativeDef(db, id)) throw new TaskError(`initiative "${id}" not found; initiatives: ${list.map((x) => x.id).join(', ')}`);
  db.wf.initiatives = [...ids.map((id) => initiativeDef(db, id)), ...list.filter((x) => !ids.includes(x.id))];
  saveWorkflow(db);
}

// the one write of workflow.json: the catalog of initiatives and aspects (the CLI, and the
// admin's one write: the rows' order)
export function saveWorkflow(db) {
  const file = path.join(db.dir, 'workflow.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db.wf, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function normId(db, raw) {
  const pad = (n) => `${db.wf.id_prefix}-${String(Number(n)).padStart(db.wf.id_pad ?? 4, '0')}`;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return pad(s);
  const m = /^([A-Za-z]+)-?(\d+)$/.exec(s);
  if (m && m[1].toUpperCase() === String(db.wf.id_prefix).toUpperCase()) return pad(m[2]);
  return s;
}

export const taskPath = (db, id) => path.join(db.itemsDir, `${id}.md`);
export const exists = (db, id) => fs.existsSync(taskPath(db, normId(db, id)));

export function loadTask(db, raw) {
  const id = normId(db, raw);
  const file = taskPath(db, id);
  if (!fs.existsSync(file)) throw new TaskError(`task ${id} not found`);
  return parseTask(fs.readFileSync(file, 'utf8'), path.relative(db.root, file));
}

export function loadAll(db) {
  const tasks = [], errors = [];
  if (!fs.existsSync(db.itemsDir)) return { tasks, errors };
  for (const f of fs.readdirSync(db.itemsDir).filter((f) => f.endsWith('.md')).sort()) {
    const file = path.join(db.itemsDir, f);
    try { tasks.push(parseTask(fs.readFileSync(file, 'utf8'), path.relative(db.root, file))); }
    catch (e) { errors.push(e.message); }
  }
  return { tasks, errors };
}

export function saveTask(db, t) {
  t.fields.updated = now();
  const file = taskPath(db, t.fields.id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, renderTask(t));
  fs.renameSync(tmp, file);
}

// The Claude Code session that made the change (its transcript is where the reasoning
// behind it lives); empty outside Claude Code.
export const sessionId = () => process.env.CLAUDE_CODE_SESSION_ID || process.env.TASKS_SESSION || undefined;

// The commit the work stood on when a task changed status (with "+" when the tree was dirty;
// skip: a path whose changes do not count, the tracker's own records): an audit takes a task's
// files from the stretches of its work, entry into in_progress to the move out of it.
export function gitHead(root, skip = '') {
  const run = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  const head = run('rev-parse', '--short', 'HEAD');
  if (head.status !== 0) return undefined;
  const dirty = run('status', '--porcelain', '--untracked-files=no', '--', '.', ...(skip ? [`:!${skip}`] : [])).stdout.trim() !== '';
  return head.stdout.trim() + (dirty ? '+' : '');
}
const trackerPath = (db) => path.relative(db.root, db.dir) || '.tasks';

export function appendEvent(db, e) {
  const ev = { ts: now(), session: sessionId(), ...e };
  for (const k of Object.keys(ev)) if (ev[k] === undefined) delete ev[k];
  fs.appendFileSync(db.eventsFile, JSON.stringify(ev) + '\n');
  return ev;
}

export function readEvents(db, id = null) {
  if (!fs.existsSync(db.eventsFile)) return [];
  const out = [];
  for (const line of fs.readFileSync(db.eventsFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (!id || e.task === id) out.push(e); } catch {}
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

function maxIdNum(db) {
  const re = new RegExp(`^${db.wf.id_prefix}-(\\d+)`);
  let max = 0;
  const ids = fs.existsSync(db.itemsDir) ? fs.readdirSync(db.itemsDir) : [];
  for (const e of readEvents(db)) ids.push(String(e.task ?? ''));
  for (const s of ids) { const m = re.exec(s); if (m) max = Math.max(max, Number(m[1])); }
  return max;
}

function checkEnum(db, field, value) {
  if (field === 'size') {
    const sizes = sizeIds(db);
    if (value != null && !sizes.includes(value)) throw new TaskError(sizes.length ? `size "${value}" is not one of: ${sizes.join(', ')}` : 'this project has no "sizes" in workflow.json');
    return;
  }
  if (field === 'initiative') {
    if (value == null) return;
    const def = initiativeDef(db, value);
    if (!def) throw new TaskError(initiatives(db).length ? `initiative "${value}" is not one of: ${initiatives(db).map((x) => x.id).join(', ')}` : 'this project has no "initiatives" in workflow.json (tasks initiative add)');
    if (def.closed) throw new TaskError(`initiative "${value}" is closed (tasks initiative open ${value})`);
    return;
  }
  const allowed = { type: db.wf.types, priority: db.wf.priorities }[field];
  if (allowed && !allowed.includes(value)) throw new TaskError(`${field} "${value}" is not one of: ${allowed.join(', ')}`);
}

function checkRefs(db, f) {
  for (const d of f.depends_on) if (!exists(db, d)) throw new TaskError(`depends_on: task ${d} not found`);
  if (f.parent && !exists(db, f.parent)) throw new TaskError(`parent: task ${f.parent} not found`);
  if (f.id && (f.parent === f.id || f.depends_on.includes(f.id))) throw new TaskError('a task cannot depend on or parent itself');
}

export function createTask(db, inp, { by = 'agent' } = {}) {
  const wf = db.wf;
  if (!String(inp.title ?? '').trim()) throw new TaskError('title is required');
  const ts = now();
  const fields = {
    id: null,
    title: String(inp.title).trim(),
    status: wf.initial_status,
    type: inp.type ?? wf.default_type,
    priority: inp.priority ?? wf.default_priority,
    size: inp.size ?? (inp.type === 'epic' && sizeIds(db).includes('epic') ? 'epic' : null),
    initiative: inp.initiative || null,
    tags: asList(inp.tags),
    parent: inp.parent ? normId(db, inp.parent) : null,
    depends_on: asList(inp.depends_on).map((d) => normId(db, d)),
    assignee: inp.assignee ?? null,
    docs: asList(inp.docs),
    origin: inp.origin ?? null,
    created: ts,
    updated: ts,
  };
  checkEnum(db, 'type', fields.type);
  checkEnum(db, 'priority', fields.priority);
  checkEnum(db, 'size', fields.size);
  checkEnum(db, 'initiative', fields.initiative);
  // a project without sizes or initiatives keeps its files as they were; origin only on tasks that have one
  if (!sizeIds(db).length) delete fields.size;
  if (!initiatives(db).length) delete fields.initiative;
  if (!fields.origin) delete fields.origin;
  checkRefs(db, fields);
  const ac = asList(inp.acceptance === undefined ? [] : inp.acceptance).map((a) => `- [ ] ${a}`).join('\n');
  const t = {
    fields,
    preamble: '',
    sections: [['Description', inp.description], inp.decision && ['Decision', inp.decision], ['Acceptance criteria', ac], ['Plan', inp.plan], ['Notes', inp.notes], ['Result', '']]
      .filter(Boolean).map(([name, text]) => ({ name, text: String(text ?? '').trim() })),
  };
  fs.mkdirSync(db.itemsDir, { recursive: true });
  for (let n = maxIdNum(db) + 1; ; n++) {
    fields.id = normId(db, n);
    try { fs.writeFileSync(taskPath(db, fields.id), renderTask(t), { flag: 'wx' }); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  appendEvent(db, { task: fields.id, type: 'created', by, to: fields.status, title: fields.title });
  return loadTask(db, fields.id);
}

export function editTask(db, raw, changes, { by = 'agent' } = {}) {
  const t = loadTask(db, raw);
  const f = t.fields, diff = {};
  for (let [k, v] of Object.entries(changes)) {
    if (k === 'id' || k === 'created' || k === 'updated') throw new TaskError(`${k} cannot be edited`);
    if (k === 'status') throw new TaskError('status changes go through move (transition rules and gates apply)');
    if (k === 'title' && !String(v ?? '').trim()) throw new TaskError('title cannot be empty');
    if (LIST_FIELDS.includes(k)) v = asList(v);
    if (k === 'depends_on') v = v.map((d) => normId(db, d));
    if (k === 'parent' && v) v = normId(db, v);
    if (v === '') v = null;
    checkEnum(db, k, v);
    if (JSON.stringify(f[k] ?? null) !== JSON.stringify(v)) { diff[k] = [f[k] ?? null, v]; f[k] = v; }
  }
  if (!Object.keys(diff).length) return { task: t, diff };
  checkRefs(db, f);
  saveTask(db, t);
  appendEvent(db, { task: f.id, type: 'edit', by, changes: diff });
  return { task: t, diff };
}

export function writeSection(db, raw, name, text, { append = false, by = 'agent' } = {}) {
  const t = loadTask(db, raw);
  const old = sectionText(t, name);
  setSection(t, name, append && old ? `${old}\n${text}` : text);
  saveTask(db, t);
  appendEvent(db, { task: t.fields.id, type: 'section', by, section: getSection(t, name).name, mode: append ? 'append' : 'set' });
  return t;
}

// A dated line in Notes. The user's own words (by user) go in as a quote, verbatim; a
// multi-line note stays one list item (continuation lines indented).
export function addNote(db, raw, text, opts = {}) {
  const body = String(text).trim().split(/\r?\n/).join('\n  ');
  const line = opts.by === 'user' ? `- ${today()} · user: «${body}»` : `- ${today()}: ${body}`;
  return writeSection(db, raw, 'Notes', line, { ...opts, append: true });
}

export function editAcceptance(db, raw, { add = [], check = [], uncheck = [], remove = [] }, { by = 'agent' } = {}) {
  const t = loadTask(db, raw);
  let text = sectionText(t, 'Acceptance criteria');
  const count = checklist(text).length;
  for (const n of [...check, ...uncheck, ...remove]) if (!(n >= 1 && n <= count)) throw new TaskError(`acceptance item #${n} does not exist (task has ${count})`);
  if (check.length) text = editChecklist(text, check, true);
  if (uncheck.length) text = editChecklist(text, uncheck, false);
  if (remove.length) text = editChecklist(text, remove, null);
  if (add.length) text = [text, ...add.map((a) => `- [ ] ${a}`)].filter(Boolean).join('\n');
  setSection(t, 'Acceptance criteria', text);
  saveTask(db, t);
  appendEvent(db, { task: t.fields.id, type: 'acceptance', by, add: add.length ? add : undefined, check: check.length ? check : undefined, uncheck: uncheck.length ? uncheck : undefined, remove: remove.length ? remove : undefined });
  return t;
}

// ---------- workflow: transitions and gates ----------

const matches = (pat, v) => pat === '*' || pat === v || (Array.isArray(pat) && pat.includes(v));
export const findTransition = (db, from, to) => db.wf.transitions.find((t) => matches(t.from, from) && matches(t.to, to)) ?? null;
export const allowedTargets = (db, from) => statusIds(db).filter((to) => to !== from && findTransition(db, from, to));

function runGate(db, t, gid, ctx) {
  const g = db.wf.gates?.[gid];
  const f = t.fields;
  const r = { gate: gid, kind: g?.kind, ok: false, message: g?.message ?? '' };
  if (!g) return { ...r, message: `gate "${gid}" is not defined in workflow.json` };
  if ((g.if_types && !g.if_types.includes(f.type)) || (g.if_tags && !g.if_tags.some((x) => f.tags.includes(x)))) return { ...r, ok: true, skipped: 'filter does not match this task' };
  switch (g.kind) {
    case 'section_nonempty':
      return { ...r, ok: meaningful(sectionText(t, g.section)), message: r.message || `section "${g.section}" must not be empty` };
    case 'checklist_nonempty':
      return { ...r, ok: checklist(sectionText(t, g.section)).length > 0, message: r.message || `section "${g.section}" needs at least one "- [ ] item"` };
    case 'checklist_complete': {
      const items = checklist(sectionText(t, g.section));
      const open = items.map((x, i) => [i + 1, x]).filter(([, x]) => !x.done);
      const msg = !items.length && !g.allow_empty ? `section "${g.section}" has no checklist items` : open.map(([n, x]) => `#${n} ${x.text}`).join('; ') + ' — unchecked';
      return { ...r, ok: (items.length > 0 || g.allow_empty === true) && !open.length, message: r.message ? `${r.message} (${msg})` : msg };
    }
    case 'field_set': {
      const v = f[g.field];
      return { ...r, ok: Array.isArray(v) ? v.length > 0 : v != null && v !== '', message: r.message || `field "${g.field}" must be set` };
    }
    case 'field_in': {
      // a path only some tasks may take, e.g. the light path for a size "tweak"
      const v = f[g.field];
      return { ...r, ok: (g.values ?? []).includes(v), message: r.message || `only for ${g.field} ${(g.values ?? []).join(' / ')} (this task: ${v ?? '—'})` };
    }
    case 'deps_done': {
      // also: statuses that count as ready besides the closed ones (e.g. "qa": the work is in, its audit pending)
      const ready = (st) => isClosed(db, st) || (g.also ?? []).includes(st);
      const open = f.depends_on.filter((d) => !exists(db, d) || !ready(loadTask(db, d).fields.status));
      return { ...r, ok: !open.length, message: r.message || `unfinished dependencies: ${open.join(', ')}` };
    }
    case 'children_done': {
      const open = loadAll(db).tasks.filter((x) => x.fields.parent === f.id && !isClosed(db, x.fields.status)).map((x) => x.fields.id);
      return { ...r, ok: !open.length, message: r.message || `unfinished child tasks: ${open.join(', ')}` };
    }
    case 'committed': {
      // the work's code is in a commit, so the move's head ends the stretch with all of it
      const res = spawnSync('git', ['status', '--porcelain', '--', '.', `:!${trackerPath(db)}`], { cwd: db.root, encoding: 'utf8' });
      const left = res.status === 0 ? res.stdout.split('\n').filter(Boolean).map((l) => l.slice(3)) : [];
      return { ...r, ok: res.status === 0 && !left.length, message: res.status !== 0 ? 'not a git repository' : `${r.message || 'commit the work first'}: ${left.slice(0, 8).join(', ')}${left.length > 8 ? ` (+${left.length - 8})` : ''}` };
    }
    case 'note_required':
      return { ...r, ok: !!ctx.note?.trim(), message: r.message || 'a --note explaining the reason is required' };
    case 'by_user':
      return { ...r, ok: ctx.by === 'user', message: r.message || 'only the user makes this move (--by user, after the user asked for it)' };
    case 'attestation': {
      const text = ctx.attest?.[gid]?.trim() ?? '';
      const min = g.min_length ?? 40;
      return { ...r, ok: text.length >= min, prompt: g.prompt, questions: g.questions ?? [], message: text ? `attestation too short (${text.length} < ${min} chars)` : `needs --attest ${gid}="…"` };
    }
    case 'audit': {
      // since: the audit must postdate this moment — by default the task's entry into its
      // current status; 'work' — the end of the work (the last move out of in_progress), so
      // the user's acceptance, which changes no code, needs no second audit
      const since = g.since === 'work' ? (readEvents(db, f.id).filter((e) => e.type === 'status' && e.from === 'in_progress').at(-1)?.ts ?? '') : enteredAt(db, f.id, f.status);
      const a = auditFor(db, f.id, since);
      const v = a?.tasks?.[f.id];
      // the guardians the auditor called (a finding in a guardian's zone) must accept it too — the
      // findings of this task only (findingTasks)
      // a finding filed to a task of its own (that task's origin) is that task's, not this one's
      const held = new Set(loadAll(db).tasks.filter((x) => x.fields.id !== f.id).map((x) => x.fields.origin).filter(Boolean));
      const open = a && v?.verdict === 'pass' ? guardianCalls(db, a).filter((c) => c.tasks.includes(f.id) && c.review?.verdict !== 'accept' && !held.has(c.finding)) : [];
      const ok = v?.verdict === 'pass' && !open.length;
      const why = open.map((c) => `${c.finding} «${c.name}»: ${c.review ? `${c.review.id} не принял — ${c.review.summary ?? ''}` : `нет детального ревью (tasks guardian review ${c.finding})`}`).join('; ');
      return { ...r, ok, audit: a?.id, message: r.message && !open.length ? r.message : (a ? (open.length ? `${a.id}: хранители не приняли: ${why}` : `${a.id}: verdict "${v?.verdict}" — fix the findings and send it to a new audit`) : 'no independent audit of this task since it entered this status (tasks audit brief → auditor agent → tasks audit add)') };
    }
    case 'guardians_asked': {
      // grooming: every guardian of the project said its word on the task (or that it is not its zone)
      const gs = loadGuardians(db);
      if (!gs.length) return { ...r, ok: true, skipped: 'no guardians in this project' };
      const says = guardianSays(t, g.section ?? GUARDIANS, gs);
      const missing = gs.filter((x) => !says.some((s) => s.guardian === x.id && meaningful(s.text)));
      const who = `не опрошены: ${missing.map((x) => `«${x.name}» (${x.id})`).join(', ')}`;
      return { ...r, ok: !missing.length, message: r.message ? `${who}. ${r.message}` : `хранители ${who} — tasks guardian brief <id> ${f.id} → свежий агент на хранителя → tasks guardian say ${f.id} <id> --file …` };
    }
    case 'command': {
      if (ctx.skipCommands) return { ...r, ok: true, skipped: 'commands not run' };
      const res = spawnSync(g.run, { shell: true, cwd: db.root, encoding: 'utf8', timeout: (g.timeout_s ?? 300) * 1000, maxBuffer: 32 << 20 });
      const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trimEnd().split('\n').slice(-30).join('\n');
      return { ...r, ok: res.status === 0, run: g.run, output, message: r.message || `\`${g.run}\` ${res.error ? res.error.message : `exited with ${res.status}`}` };
    }
    default:
      return { ...r, message: `unknown gate kind "${g.kind}"` };
  }
}

// Commands run only after every cheap gate has passed — no point building while the checklist is open.
export function evaluateGates(db, t, gateIds, ctx = {}) {
  const isCmd = (gid) => db.wf.gates?.[gid]?.kind === 'command';
  const results = gateIds.filter((g) => !isCmd(g)).map((g) => runGate(db, t, g, ctx));
  const cheapOk = results.every((r) => r.ok);
  for (const g of gateIds.filter(isCmd)) {
    results.push(cheapOk ? runGate(db, t, g, ctx) : { gate: g, kind: 'command', ok: false, message: 'not run until the other gates pass' });
  }
  return results;
}

export function checkMove(db, raw, to, ctx = {}) {
  const t = loadTask(db, raw);
  const from = t.fields.status;
  if (!statusDef(db, to)) throw new TaskError(`unknown status "${to}"; statuses: ${statusIds(db).join(', ')}`);
  if (from === to) throw new TaskError(`${t.fields.id} is already ${to}`);
  const tr = findTransition(db, from, to);
  if (!tr) throw new TaskError(`${from} → ${to} is not allowed; from ${from} you can go to: ${allowedTargets(db, from).join(', ') || 'nowhere'}`);
  const results = evaluateGates(db, t, tr.gates ?? [], ctx);
  return { task: t, from, to, transition: tr, results, failed: results.filter((r) => !r.ok) };
}

export function moveTask(db, raw, to, { note = '', attest = {}, by = 'agent', force = false, skipCommands = false } = {}) {
  const chk = checkMove(db, raw, to, { note, attest, by, skipCommands });
  const { task: t, from, transition, results, failed } = chk;
  if (failed.length && !force) return { ...chk, moved: false };
  if (force && !note.trim()) throw new TaskError('--force needs a --note saying why the gates are bypassed');
  t.fields.status = to;
  if (note.trim()) {
    const old = sectionText(t, 'Notes');
    setSection(t, 'Notes', `${old ? old + '\n' : ''}- ${today()} ${from} → ${to}: ${note.trim()}`);
  }
  saveTask(db, t);
  const gates = transition.gates ?? [];
  const head = gitHead(db.root, trackerPath(db));
  const attested = Object.fromEntries(Object.entries(attest).filter(([g]) => gates.includes(g)));
  const checks = Object.fromEntries(results.filter((r) => r.kind === 'command').map((r) => [r.gate, r.skipped ? 'skipped' : r.ok ? 'ok' : 'failed']));
  appendEvent(db, {
    task: t.fields.id, type: 'status', by, from, to, head,
    note: note.trim() || undefined,
    attest: Object.keys(attested).length ? attested : undefined,
    checks: Object.keys(checks).length ? checks : undefined,
    forced: force && failed.length ? failed.map((r) => r.gate) : undefined,
  });
  return { ...chk, moved: true };
}

// ---------- audits: independent reviews of tasks and of the code (.tasks/audits/A-0001.json) ----------
// An audit is written once by the auditor's verdict (tasks audit add) and never edited; a later
// audit supersedes it for the files it covers and may resolve its findings ("resolves").

export const auditsDir = (db) => path.join(db.dir, AUDITS);

export function loadAudits(db) {
  const dir = auditsDir(db);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^A-\d+\.json$/.test(f)).sort()
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

// when the task last entered its current status
export function enteredAt(db, id, status) {
  const ev = readEvents(db, id).filter((e) => (e.type === 'status' || e.type === 'created') && e.to === status);
  return ev.at(-1)?.ts ?? '';
}

// the latest audit that judged this task after `since`
export function auditFor(db, id, since = '') {
  return loadAudits(db).filter((a) => a.tasks?.[id] && a.ts >= since).at(-1) ?? null;
}

export function saveAudit(db, a) {
  const dir = auditsDir(db);
  fs.mkdirSync(dir, { recursive: true });
  let n = loadAudits(db).reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D+/g, '')) || 0), 0) + 1;
  for (; ; n++) {
    a.id = `A-${String(n).padStart(4, '0')}`;
    try { fs.writeFileSync(path.join(dir, `${a.id}.json`), JSON.stringify(a, null, 2) + '\n', { flag: 'wx' }); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  for (const [task, v] of Object.entries(a.tasks ?? {})) appendEvent(db, { task, type: 'audit', by: 'auditor', audit: a.id, verdict: v.verdict });
  return a;
}

// ---------- guardians: the owners of zones (references/guardians.md) ----------
// A guardian owns a zone of the project: how a thing is done right wherever in the code it is done,
// through one common place. A project registers its guardians as charters, one markdown file each
// (project.json guardians.charters: a folder from the project's root); a project without them works
// as before. A guardian says its word on a task at grooming (the task's ## Guardians, gate
// guardians_asked) and reviews in detail a finding the auditor put in its zone (GR-0001.json beside
// the audits; the audit gate waits for every called guardian to accept).

export const GUARDIANS = 'Guardians';
export const CHARTER_SECTIONS = ['Кратко', 'Зона', 'Общее место и двери', 'Правила', 'Признаки обхода', 'История багов'];

export function projectConfig(db) {
  const file = path.join(db.dir, 'project.json');
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; } catch { return {}; }
}
// { charters, check } or null: the project has no guardians
export function guardiansConfig(db) {
  const g = projectConfig(db).guardians;
  return g?.charters ? { charters: String(g.charters).replace(/\/$/, ''), check: g.check ?? null } : null;
}

// the charters: { id, name, pillar, check, file, sections: { name: text }, summary, text, problems }
export function loadGuardians(db) {
  const cfg = guardiansConfig(db);
  if (!cfg) return [];
  const dir = path.join(db.root, cfg.charters);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !/^readme\.md$/i.test(f)).sort().map((f) => {
    const file = path.posix.join(cfg.charters, f), text = fs.readFileSync(path.join(dir, f), 'utf8');
    const problems = [];
    let fields = {}, body = text;
    try { ({ fields, body } = parseFront(text, file)); } catch (e) { problems.push(e.message); }
    const id = String(fields.id ?? path.basename(f, '.md'));
    const sections = Object.fromEntries(parseBody(body).sections.map((s) => [s.name, s.text]));
    if (id !== path.basename(f, '.md')) problems.push(`${file}: id "${id}" does not match the file name`);
    if (!String(fields.name ?? '').trim()) problems.push(`${file}: "name" is required (the guardian's name, as people call it)`);
    for (const s of CHARTER_SECTIONS) if (!meaningful(sections[s] ?? '')) problems.push(`${file}: section "## ${s}" is missing or empty`);
    return { id, name: String(fields.name ?? id), pillar: fields.pillar ?? null, check: fields.check ?? null, file, sections, summary: sections['Кратко'] ?? '', text, problems };
  });
}
export const guardianOf = (db, raw) => loadGuardians(db).find((g) => g.id === String(raw) || g.name.toLowerCase() === String(raw).replace(/[«»]/g, '').toLowerCase()) ?? null;

// what the guardians said on a task: its ## Guardians, a "### «Name»" (or "### id") subsection each
export function guardianSays(t, section = GUARDIANS, guardians = null) {
  const text = sectionText(t, section);
  const out = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^###[ \t]+(.+?)[ \t]*$/.exec(line);
    if (h) out.push((cur = { heading: h[1], lines: [] }));
    else cur?.lines.push(line);
  }
  return out.map((x) => {
    const key = x.heading.replace(/[«»"]/g, '').split(/\s+[—–-]\s+/)[0].trim().toLowerCase();
    const g = (guardians ?? []).find((y) => y.id.toLowerCase() === key || y.name.toLowerCase() === key);
    return { heading: x.heading, key, guardian: g?.id ?? key, text: x.lines.join('\n').trim() };
  });
}
// a guardian's word on a task, as it said it: its subsection set (an earlier one replaced)
export function writeGuardianSay(db, raw, guardian, text, { by = 'guardian' } = {}) {
  const t = loadTask(db, raw);
  const g = guardianOf(db, guardian) ?? (() => { throw new TaskError(`no guardian "${guardian}" (see tasks guardian list)`); })();
  const gs = loadGuardians(db);
  const says = guardianSays(t, GUARDIANS, gs).filter((s) => s.guardian !== g.id);
  says.push({ heading: `«${g.name}»`, guardian: g.id, text: String(text).trim() });
  const order = (s) => { const i = gs.findIndex((x) => x.id === s.guardian); return i < 0 ? 1e9 : i; };
  setSection(t, GUARDIANS, says.sort((a, b) => order(a) - order(b)).map((s) => `### ${s.heading}\n\n${s.text}`).join('\n\n'));
  saveTask(db, t);
  appendEvent(db, { task: t.fields.id, type: 'guardian', by, guardian: g.id, mode: 'say' });
  return t;
}

// the detailed reviews of the guardians (.tasks/audits/GR-0001.json), written once each
export function loadGuardianReviews(db) {
  const dir = auditsDir(db);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^GR-\d+\.json$/.test(f)).sort()
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
// the findings of an audit the auditor put in a guardian's zone, each with its latest review
export function guardianCalls(db, a, reviews = loadGuardianReviews(db)) {
  const gs = loadGuardians(db);
  return (a.findings ?? []).map((f, i) => ({ f, finding: `${a.id}#${i + 1}` })).filter(({ f }) => f.guardian).map(({ f, finding }) => ({
    finding, guardian: f.guardian, name: gs.find((g) => g.id === f.guardian)?.name ?? f.guardian, title: f.title,
    severity: f.severity ?? null, tasks: findingTasks(db, a, f),
    review: reviews.filter((r) => r.finding === finding && r.guardian === f.guardian).at(-1) ?? null,
  }));
}
// the audit's tasks a finding belongs to: the ones it names ("tasks": [...]), else the ones whose
// work (workFiles) changed one of its code files (the tracker's records and the .md notes left out:
// every task's bookkeeping touches them); none matched — every task of the audit (a finding nobody
// can place holds them all)
export function findingTasks(db, a, f) {
  const all = Object.keys(a.tasks ?? {});
  if (Array.isArray(f.tasks) && f.tasks.length) return f.tasks.filter((t) => all.includes(t));
  const code = (x) => !x.startsWith('.tasks/') && !x.endsWith('.md');
  const files = new Set((f.files ?? []).map((x) => String(x).replace(/:[\d,-]+$/, '')).filter(code));
  const hit = all.filter((t) => workFiles(db, t).some((x) => code(x) && files.has(x)));
  return hit.length ? hit : all;
}
// The stretches of a task's work, { from, to, at }: from the commit it entered in_progress at (at: when)
// to the commit it left at (gate `committed`: the code is in it); one still open has to: null (the
// working tree). A stretch left with code uncommitted ("+", from before the gate) ends at the next
// commit, where that code landed (at its own head when there is none on the way to HEAD).
export function workRanges(db, id) {
  const git = (...a) => spawnSync('git', a, { cwd: db.root, encoding: 'utf8' });
  const clean = (h) => h?.replace(/\+$/, '') ?? null;
  const out = [];
  let open = null;
  for (const e of readEvents(db, normId(db, id)).filter((x) => x.type === 'status')) {
    if (e.to === 'in_progress' && !open) open = { from: clean(e.head), at: e.ts };
    else if (e.from === 'in_progress' && open) {
      let to = clean(e.head);
      if (to && e.head.endsWith('+')) to = git('rev-list', '--reverse', '--ancestry-path', `${to}..HEAD`).stdout.split('\n')[0]?.slice(0, 7) || to;
      if (open.from && to) out.push({ ...open, to });
      open = null;
    }
  }
  if (open?.from) out.push({ ...open, to: null });
  return out;
}
// The files a task's work changed (after: only the stretches begun after that moment, e.g. its last
// audit; an open stretch with the untracked files too)
export function workFiles(db, id, { after = '' } = {}) {
  const git = (...a) => spawnSync('git', a, { cwd: db.root, encoding: 'utf8', maxBuffer: 64 << 20 }).stdout.split('\n').filter(Boolean);
  const files = new Set();
  for (const r of workRanges(db, id).filter((x) => x.at > after)) {
    for (const f of git('diff', '--name-only', r.from, ...(r.to ? [r.to] : []))) files.add(f);
    if (!r.to) for (const f of git('ls-files', '--others', '--exclude-standard')) files.add(f);
  }
  return [...files].sort();
}
export function saveGuardianReview(db, r) {
  const errs = [];
  if (!r || typeof r !== 'object') throw new TaskError('the review must be a JSON object');
  const g = guardianOf(db, r.guardian);
  if (!g) errs.push(`"guardian" must be a guardian of the project (${loadGuardians(db).map((x) => x.id).join(', ') || 'none'})`);
  const [aid, n] = String(r.finding ?? '').toUpperCase().split('#');
  const a = loadAudits(db).find((x) => x.id === aid);
  const f = a?.findings?.[Number(n) - 1];
  if (!f) errs.push(`"finding" must be a finding of an audit (A-0001#2): ${r.finding}`);
  else if (g && f.guardian !== g.id) errs.push(`${r.finding} was not put in the zone of «${g.name}» (its guardian: ${f.guardian ?? 'none'})`);
  if (!['accept', 'reject'].includes(r.verdict)) errs.push('"verdict" must be accept|reject');
  if (!String(r.summary ?? '').trim()) errs.push('"summary" is required');
  if (r.verdict === 'reject' && !String(r.how ?? '').trim()) errs.push('a reject needs "how": how it is done right through the common place');
  if (errs.length) throw new TaskError('review rejected:\n  ' + errs.join('\n  '));
  const rec = { id: null, ts: now(), session: sessionId() ?? null, head: gitHead(db.root) ?? null, ...r, guardian: g.id, finding: `${aid}#${n}` };
  const dir = auditsDir(db);
  fs.mkdirSync(dir, { recursive: true });
  let k = loadGuardianReviews(db).reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D+/g, '')) || 0), 0) + 1;
  for (; ; k++) {
    rec.id = `GR-${String(k).padStart(4, '0')}`;
    try { fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2) + '\n', { flag: 'wx' }); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  for (const task of Object.keys(a.tasks ?? {})) appendEvent(db, { task, type: 'guardian', by: 'guardian', guardian: g.id, review: rec.id, finding: rec.finding, verdict: rec.verdict });
  return rec;
}

// Highest-priority open task in the first "todo"-category statuses whose dependencies are closed.
// A status with "hold": true (an icebox) is never offered.
export function nextTasks(db, limit = 5) {
  const { tasks } = loadAll(db);
  const prio = (t) => db.wf.priorities.indexOf(t.fields.priority);
  const ready = tasks.filter((t) => statusDef(db, t.fields.status)?.category === 'todo' && !statusDef(db, t.fields.status).hold && t.fields.depends_on.every((d) => exists(db, d) && isClosed(db, loadTask(db, d).fields.status)));
  const order = statusIds(db);
  return ready.sort((a, b) => order.indexOf(b.fields.status) - order.indexOf(a.fields.status) || prio(a) - prio(b) || a.fields.id.localeCompare(b.fields.id)).slice(0, limit);
}

// ---------- validation and export ----------

export function validateDb(db) {
  const errors = [], warnings = [];
  const wf = db.wf, ids = statusIds(db);
  for (const k of ['id_prefix', 'statuses', 'initial_status', 'transitions', 'types', 'priorities', 'default_type', 'default_priority']) if (wf[k] == null) errors.push(`workflow.json: "${k}" is missing`);
  if (!ids.includes(wf.initial_status)) errors.push(`workflow.json: initial_status "${wf.initial_status}" is not a status`);
  for (const s of wf.statuses ?? []) if (!['todo', 'active', 'done'].includes(s.category)) errors.push(`workflow.json: status "${s.id}" category must be todo|active|done`);
  for (const [i, tr] of (wf.transitions ?? []).entries()) {
    for (const end of ['from', 'to']) for (const s of [tr[end]].flat()) if (s !== '*' && !ids.includes(s)) errors.push(`workflow.json: transitions[${i}].${end} "${s}" is not a status`);
    for (const g of tr.gates ?? []) if (!wf.gates?.[g]) errors.push(`workflow.json: transitions[${i}] uses undefined gate "${g}"`);
  }
  for (const [gid, g] of Object.entries(wf.gates ?? {})) if (!GATE_KINDS.includes(g.kind)) errors.push(`workflow.json: gate "${gid}" has unknown kind "${g.kind}"`);
  const seen = new Set();
  for (const x of initiatives(db)) {
    if (!x?.id || !BARE.test(x.id) || !String(x.title ?? '').trim()) errors.push(`workflow.json: initiative ${JSON.stringify(x)} needs an id (a bare word) and a title`);
    else if (seen.has(x.id)) errors.push(`workflow.json: initiative "${x.id}" is listed twice`);
    seen.add(x?.id);
  }
  for (const a of aspects(db)) if (!a?.tag || !String(a.title ?? '').trim()) errors.push(`workflow.json: aspect ${JSON.stringify(a)} needs a tag and a title`);
  const gcfg = guardiansConfig(db);
  if (gcfg && !fs.existsSync(path.join(db.root, gcfg.charters))) errors.push(`project.json: guardians.charters "${gcfg.charters}" is not a folder`);
  for (const g of loadGuardians(db)) errors.push(...g.problems);

  const { tasks, errors: parseErrors } = loadAll(db);
  errors.push(...parseErrors);
  const byId = new Map(tasks.map((t) => [t.fields.id, t]));
  for (const t of tasks) {
    const f = t.fields, where = t.file;
    for (const k of REQUIRED) if (f[k] == null || f[k] === '') errors.push(`${where}: "${k}" is required`);
    if (path.basename(t.file, '.md') !== f.id) errors.push(`${where}: id "${f.id}" does not match the file name`);
    if (f.status && !ids.includes(f.status)) errors.push(`${where}: status "${f.status}" is not defined`);
    if (f.type && !wf.types.includes(f.type)) errors.push(`${where}: type "${f.type}" is not defined`);
    if (f.priority && !wf.priorities.includes(f.priority)) errors.push(`${where}: priority "${f.priority}" is not defined`);
    if (f.size != null && !sizeIds(db).includes(f.size)) errors.push(`${where}: size "${f.size}" is not defined`);
    if (f.initiative != null && !initiativeDef(db, f.initiative)) errors.push(`${where}: initiative "${f.initiative}" is not defined`);
    for (const k of ['created', 'updated']) if (f[k] && Number.isNaN(Date.parse(f[k]))) errors.push(`${where}: ${k} "${f[k]}" is not an ISO date`);
    for (const d of f.depends_on) if (!byId.has(d)) errors.push(`${where}: depends_on ${d} does not exist`);
    if (f.parent && !byId.has(f.parent)) errors.push(`${where}: parent ${f.parent} does not exist`);
    for (const d of f.docs) if (!fs.existsSync(path.join(db.dir, d))) warnings.push(`${where}: doc ${d} not found under ${DIR}/`);
    for (const k of Object.keys(f)) if (!FIELD_ORDER.includes(k)) warnings.push(`${where}: unknown field "${k}" (kept as is)`);
    for (const s of SECTIONS) if (!getSection(t, s)) warnings.push(`${where}: section "## ${s}" is missing`);
  }
  // dependency cycles
  const state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { errors.push(`dependency cycle: ${[...stack, id].join(' → ')}`); return; }
    state.set(id, 1);
    for (const d of byId.get(id)?.fields.depends_on ?? []) if (byId.has(d)) visit(d, [...stack, id]);
    state.set(id, 2);
  };
  for (const id of byId.keys()) visit(id, []);
  if (fs.existsSync(db.eventsFile)) {
    fs.readFileSync(db.eventsFile, 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      try { const e = JSON.parse(line); if (!e.ts || !e.task || !e.type) errors.push(`events.jsonl:${i + 1}: needs ts, task, type`); }
      catch { errors.push(`events.jsonl:${i + 1}: not valid JSON`); }
    });
  }
  return { errors, warnings, count: tasks.length };
}

export function taskJson(t) {
  return {
    ...t.fields,
    file: t.file,
    sections: Object.fromEntries(t.sections.map((s) => [s.name, s.text])),
    acceptance: checklist(sectionText(t, 'Acceptance criteria')),
  };
}

export function exportDb(db) {
  return { format: FORMAT, exported: now(), workflow: db.wf, tasks: loadAll(db).tasks.map(taskJson), events: readEvents(db) };
}
