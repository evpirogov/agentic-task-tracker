#!/usr/bin/env node
// CLI over the .tasks/ store. Every write goes through lib.mjs so the format stays valid.
// Exit codes: 0 ok, 1 error, 2 transition blocked by gates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';
import * as C from './code.mjs';
import { serve } from './serve.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOL = new Set(['json', 'all', 'force', 'stdin', 'append', 'no-commands', 'help', 'open', 'red', 'stale', 'only-files', 'lanes', 'rest', 'replace', 'remove']);

const USAGE = `tasks.mjs — file-based task tracker (.tasks/)

  init [--prefix BL] [--template pipeline]   create .tasks/ in the current directory (templates/workflow[.<name>].json)
  add <title…> [--type t] [--priority p] [--size s] [--initiative i] [--tags a,b] [--desc text] [--ac item]… [--plan text]
               [--decision text] [--deps T-1,T-2] [--parent T-3] [--docs docs/x.md] [--status s] [--by user|agent]
  add --stdin                                JSON object or array (see references/format.md)
  list [--status a,b] [--type t] [--size s] [--initiative i|none] [--tag x] [--all] [--json]
  board [--all] [--lanes]                    kanban view by status; --lanes: a row per initiative
  next                                       ready tasks: todo-category, dependencies closed
  show <id> [--json]                         task file + history
  check <id> <status> [--attest gate=text]… [--note text] [--no-commands]   dry-run a transition
  move <id> <status> [--note text] [--attest gate=text]… [--by who] [--force]
  edit <id> [--title t] [--type t] [--priority p] [--size s|none] [--initiative i|none] [--tags a,b] [--add-tag x] [--rm-tag x]
            [--deps …] [--parent id|none] [--assignee who|none] [--docs …] [--origin A-1#2|none]
  section <id> <name> [--append | --replace] (<text…> | --stdin)   text already there: --append adds, --replace rewrites
  section <id> <name> --remove                remove a section (a stray one)
  note <id> <text…> [--by user]              dated line in ## Notes (--by user: the user's words, verbatim)
  ac <id> [--add text]… [--check 1,2] [--uncheck 3] [--rm 4]
  initiative [list]                          the project's initiatives (rows of the board) with their tasks counted
  initiative add <id> <title…> [--goal text] [--before id]
  initiative edit <id> [--title t] [--goal text|none] [--before id|last]
  initiative order <id> <id>…                the rows' order, top first (the ones not named keep theirs after)
  initiative close|open <id>                 a closed one leaves the board; its tasks keep it
  aspect [list] | aspect add <tag> <title…> | aspect rm <tag>   tags for a quality across initiatives (e.g. perf)
  history [<id>] [--json]
  validate                                   check every file against the format
  export                                     whole store as JSON (for UIs)
  serve [--port 4747] [--host 127.0.0.1] [--open]   the admin in the browser (read-only): tasks, wiki, code
                                                  (host: .tasks/project.json serve.host by default)
  code [<path>] [--red] [--stale] [--json]   the code's state: scan + audits (.tasks/project.json)
  audit brief [<id>…] [--files a,b] [--since <git ref>] [--all-pillars] [--title t] [--out brief.md] [--verdict v.json]   an auditor's brief
  audit add (--file f | --stdin)             record the auditor's JSON verdict as written
  audit list | audit show <A-1>              audits; audit task <A-1#2> files a finding as a backlog task
  guardian [list]                            the project's guardians (charters: project.json guardians), their check
  guardian brief <guardian> <id> [--draft decision.md] [--out brief.md] [--answer a.md]   grooming: a guardian asked about a task
  guardian say <id> <guardian> (--file f | --stdin)   its answer into the task's ## Guardians, as it wrote it
  guardian review <A-1#2> [--out brief.md] [--verdict v.json]   Arch QA: a finding in a guardian's zone, for its review
  guardian add (--file f | --stdin)          record the guardian's JSON verdict as written; guardian show <GR-1>
  guardian sweep [--guardians a,b] [--rest] [--area id | --files a,b] [--lines 8000] [--dir D]
                                             the audit of the whole project by every guardian (on the user's request):
                                             what each has read, its batches; --dir writes a brief per batch
  guardian sweep add (--file f | --stdin)    record a guardian's sweep verdict (its marks per file) as written`;

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (v === undefined) {
      if (BOOL.has(k)) v = true;
      else if (i + 1 < argv.length) v = argv[++i];
      else die(`--${k} needs a value`);
    }
    (opt[k] ??= []).push(v);
  }
  return { pos, opt };
}

const die = (msg, code = 1) => { console.error(`error: ${msg}`); process.exit(code); };
const one = (o, k) => o[k]?.at(-1);
const many = (o, k) => (o[k] ?? []).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
const nums = (o, k) => many(o, k).map(Number);
const by = (o) => one(o, 'by') ?? 'agent';
const stdin = () => fs.readFileSync(0, 'utf8');
const none = (v) => (v === 'none' ? null : v);

function attestMap(o) {
  const out = {};
  for (const a of o.attest ?? []) {
    const i = String(a).indexOf('=');
    if (i < 1) die(`--attest expects gate=text, got "${a}"`);
    out[a.slice(0, i).trim()] = a.slice(i + 1);
  }
  return out;
}

const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function line(db, t) {
  const f = t.fields;
  const ac = L.checklist(L.sectionText(t, 'Acceptance criteria'));
  const extra = [
    ac.length ? `[${ac.filter((x) => x.done).length}/${ac.length}]` : '',
    f.initiative ? `◆ ${f.initiative}` : '',
    f.tags.map((x) => '#' + x).join(' '),
    f.depends_on.length ? `⟵ ${f.depends_on.join(',')}` : '',
    f.parent ? `↑ ${f.parent}` : '',
  ].filter(Boolean).join('  ');
  const size = L.sizeIds(db).length ? ` ${pad(f.size ?? '—', 5)}` : '';
  return `${pad(f.id, 7)} ${pad(f.status, 12)} ${pad(f.priority, 3)} ${pad(f.type, 8)}${size} ${cut(f.title, 70)}${extra ? '  ' + extra : ''}`;
}

function sortTasks(db, tasks) {
  const so = L.statusIds(db), po = db.wf.priorities;
  return tasks.sort((a, b) => so.indexOf(a.fields.status) - so.indexOf(b.fields.status)
    || po.indexOf(a.fields.priority) - po.indexOf(b.fields.priority) || a.fields.id.localeCompare(b.fields.id));
}

function printGates(results) {
  for (const r of results) {
    const mark = r.skipped ? '–' : r.ok ? '✓' : '✗';
    console.log(`  ${mark} ${r.gate}${r.kind && r.kind !== r.gate ? ` (${r.kind})` : ''}${r.skipped ? ` — skipped: ${r.skipped}` : r.ok ? '' : ` — ${r.message}`}`);
    if (!r.ok && r.kind === 'attestation') {
      if (r.prompt) console.log(`      ${r.prompt}`);
      r.questions?.forEach((q, i) => console.log(`      ${i + 1}. ${q}`));
    }
    if (!r.ok && r.output) console.log(r.output.split('\n').map((l) => '      | ' + l).join('\n'));
  }
}

function fmtEvent(e) {
  const t = e.ts.replace('T', ' ').slice(0, 16);
  let s = `${t}  ${pad(e.task, 7)} ${pad(e.type, 10)} `;
  if (e.type === 'status') s += `${e.from} → ${e.to}`;
  else if (e.type === 'created') s += `"${e.title}" in ${e.to}`;
  else if (e.type === 'edit') s += Object.entries(e.changes ?? {}).map(([k, [a, b]]) => `${k}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`).join('; ');
  else if (e.type === 'section') s += `${e.mode} ## ${e.section}`;
  else if (e.type === 'acceptance') s += ['add', 'check', 'uncheck', 'remove'].filter((k) => e[k]).map((k) => `${k} ${JSON.stringify(e[k])}`).join('; ');
  else if (e.type === 'audit') s += `${e.audit}: ${e.verdict}`;
  else if (e.type === 'guardian') s += e.review ? `«${e.guardian}» ${e.review} on ${e.finding}: ${e.verdict}` : `«${e.guardian}» said its word (## Guardians)`;
  if (e.head) s += `  @${e.head}`;
  if (e.session) s += `  session ${e.session.slice(0, 8)}`;
  s += `  by ${e.by ?? '?'}`;
  if (e.forced) s += `  FORCED past ${e.forced.join(', ')}`;
  if (e.note) s += `\n      note: ${e.note}`;
  for (const [g, v] of Object.entries(e.attest ?? {})) s += `\n      ${g}: ${v}`;
  if (e.checks) s += `\n      checks: ${Object.entries(e.checks).map(([g, v]) => `${g}=${v}`).join(', ')}`;
  return s;
}

function cmdInit(o) {
  const root = process.cwd();
  const dir = path.join(root, L.DIR);
  if (fs.existsSync(path.join(dir, 'workflow.json'))) die(`${L.DIR}/workflow.json already exists`);
  fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const tpl = one(o, 'template');
  const wfFile = path.join(SKILL, 'templates', tpl ? `workflow.${tpl}.json` : 'workflow.json');
  if (!fs.existsSync(wfFile)) die(`no template ${path.basename(wfFile)} in ${path.join(SKILL, 'templates')}`);
  const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
  if (one(o, 'prefix')) wf.id_prefix = one(o, 'prefix').toUpperCase();
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify(wf, null, 2) + '\n');
  fs.copyFileSync(path.join(SKILL, 'references', 'format.md'), path.join(dir, 'README.md'));
  if (!fs.existsSync(path.join(dir, 'events.jsonl'))) fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  for (const sub of ['items', 'docs']) if (!fs.readdirSync(path.join(dir, sub)).length) fs.writeFileSync(path.join(dir, sub, '.gitkeep'), '');
  const ga = path.join(root, '.gitattributes');
  const rule = `${L.DIR}/events.jsonl merge=union`;
  const cur = fs.existsSync(ga) ? fs.readFileSync(ga, 'utf8') : '';
  if (!cur.includes(rule)) fs.writeFileSync(ga, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + rule + '\n');
  console.log(`created ${L.DIR}/ (workflow.json, README.md, items/, docs/, events.jsonl) and .gitattributes rule`);
  console.log(`next: tune ${L.DIR}/workflow.json gates for this project; add the CLAUDE.md block from ${path.join(SKILL, 'templates', 'CLAUDE.snippet.md')}`);
}

function cmdAdd(db, o, pos) {
  let items;
  if (o.stdin) {
    const data = JSON.parse(stdin());
    items = Array.isArray(data) ? data : [data];
  } else {
    items = [{
      title: pos.join(' '), type: one(o, 'type'), priority: one(o, 'priority'), size: one(o, 'size'), initiative: one(o, 'initiative'), tags: many(o, 'tags'),
      description: one(o, 'desc'), decision: one(o, 'decision'), acceptance: o.ac ?? [], plan: one(o, 'plan'), depends_on: many(o, 'deps'),
      parent: one(o, 'parent'), docs: many(o, 'docs'), status: one(o, 'status'),
    }];
  }
  // inside one batch "@ref" points at another item's ref, so dictated chains can be wired up in one go
  const refs = {};
  const resolve = (v) => (typeof v === 'string' && v.startsWith('@') ? refs[v.slice(1)] ?? die(`unknown ref ${v} (refs must be defined earlier in the batch)`) : v);
  items.forEach((it, i) => {
    if (!String(it.title ?? '').trim()) die(`item #${i + 1}: title is required`);
    if (it.type && !db.wf.types.includes(it.type)) die(`item #${i + 1}: type "${it.type}" is not one of: ${db.wf.types.join(', ')}`);
    if (it.priority && !db.wf.priorities.includes(it.priority)) die(`item #${i + 1}: priority "${it.priority}" is not one of: ${db.wf.priorities.join(', ')}`);
    if (it.size && !L.sizeIds(db).includes(it.size)) die(`item #${i + 1}: size "${it.size}" is not one of: ${L.sizeIds(db).join(', ') || '(no sizes in workflow.json)'}`);
    if (it.status && !L.statusDef(db, it.status)) die(`item #${i + 1}: unknown status "${it.status}"`);
    if (it.initiative && !L.initiativeDef(db, it.initiative)) die(`item #${i + 1}: initiative "${it.initiative}" is not one of: ${L.initiatives(db).map((x) => x.id).join(', ') || '(none: tasks initiative add)'}`);
  });
  let blocked = 0;
  for (const it of items) {
    const t = L.createTask(db, { ...it, parent: resolve(it.parent), depends_on: [it.depends_on ?? []].flat().map(resolve) }, { by: it.by ?? by(o) });
    if (it.ref) refs[it.ref] = t.fields.id;
    console.log(`+ ${t.fields.id} [${t.fields.status}] ${t.fields.title}`);
    if (it.status && it.status !== t.fields.status) {
      const r = L.moveTask(db, t.fields.id, it.status, { by: it.by ?? by(o), skipCommands: true });
      if (r.moved) console.log(`  → ${it.status}`);
      else { blocked++; console.log(`  stays in ${t.fields.status}: ${r.failed.map((x) => `${x.gate} — ${x.message}`).join('; ')}`); }
    }
  }
  if (blocked) process.exitCode = 2;
}

function cmdList(db, o) {
  let ts = L.loadAll(db).tasks;
  const st = many(o, 'status'), ty = many(o, 'type'), sz = many(o, 'size'), tg = many(o, 'tag'), ini = many(o, 'initiative');
  if (st.length) ts = ts.filter((t) => st.includes(t.fields.status));
  else if (!o.all) ts = ts.filter((t) => !L.isClosed(db, t.fields.status));
  if (ty.length) ts = ts.filter((t) => ty.includes(t.fields.type));
  if (sz.length) ts = ts.filter((t) => sz.includes(t.fields.size));
  if (ini.length) ts = ts.filter((t) => ini.includes(t.fields.initiative ?? 'none'));
  if (tg.length) ts = ts.filter((t) => tg.some((x) => t.fields.tags.includes(x)));
  sortTasks(db, ts);
  if (o.json) return console.log(JSON.stringify(ts.map(L.taskJson), null, 2));
  if (!ts.length) return console.log('(no tasks)');
  ts.forEach((t) => console.log(line(db, t)));
}

const boardLine = (db, t) => `   ${pad(t.fields.id, 7)} ${pad(t.fields.priority, 3)}${L.sizeIds(db).length ? ' ' + pad(t.fields.size ?? '—', 5) : ''} ${cut(t.fields.title, 80)}${t.fields.tags.length ? '  ' + t.fields.tags.map((x) => '#' + x).join(' ') : ''}`;

// a row per open initiative (catalog order, then the tasks without one); in a row the open
// statuses list their tasks, closed and held ones only their counts unless --all
function cmdLanes(db, o) {
  const all = sortTasks(db, L.loadAll(db).tasks);
  const lanes = [...L.initiatives(db).filter((x) => !x.closed), { id: null, title: 'Без инициативы' }];
  for (const lane of lanes) {
    const ts = all.filter((t) => (t.fields.initiative ?? null) === lane.id);
    if (!ts.length && lane.id === null) continue;
    const open = ts.filter((t) => !L.isClosed(db, t.fields.status));
    console.log(`\n══ ${lane.title}${lane.id ? ` (${lane.id})` : ''} — ${open.length} open, ${ts.length - open.length} closed${lane.goal ? `\n   ${lane.goal}` : ''}`);
    for (const s of db.wf.statuses) {
      const col = ts.filter((t) => t.fields.status === s.id);
      if (!col.length) continue;
      const brief = (s.category === 'done' || s.hold) && !o.all;
      console.log(`  ── ${s.title ?? s.id} (${col.length})`);
      if (!brief) col.forEach((t) => console.log(boardLine(db, t)));
    }
  }
}

function cmdBoard(db, o) {
  if (o.lanes) return cmdLanes(db, o);
  const all = sortTasks(db, L.loadAll(db).tasks);
  for (const s of db.wf.statuses) {
    let col = all.filter((t) => t.fields.status === s.id);
    const total = col.length;
    if (s.category === 'done' && !o.all) col = col.sort((a, b) => b.fields.updated.localeCompare(a.fields.updated)).slice(0, 5);
    console.log(`\n── ${s.title ?? s.id} (${total})${col.length < total ? ` — latest ${col.length}, --all for every` : ''}`);
    for (const t of col) console.log(boardLine(db, t));
  }
}

function cmdMove(db, o, pos, dry) {
  const [id, to] = pos;
  if (!id || !to) die(`${dry ? 'check' : 'move'} <id> <status>`);
  const ctx = { note: one(o, 'note') ?? '', attest: attestMap(o), by: by(o), force: !!o.force, skipCommands: !!o['no-commands'] };
  const r = dry ? L.checkMove(db, id, to, ctx) : L.moveTask(db, id, to, ctx);
  const head = `${r.task.fields.id} ${r.from} → ${r.to}`;
  if (dry) console.log(`${r.failed.length ? '✗' : '✓'} ${head}: ${r.failed.length ? `${r.failed.length} gate(s) would block` : 'all gates pass'}`);
  else if (r.moved) console.log(`✓ ${head}${r.failed.length ? `  (FORCED past ${r.failed.map((x) => x.gate).join(', ')})` : ''}`);
  else console.log(`✗ ${head} blocked by ${r.failed.length} gate(s):`);
  if (r.results.length && (dry || r.failed.length)) printGates(r.results);
  if (r.failed.length && !(r.moved)) process.exitCode = 2;
}

function cmdEdit(db, o, pos) {
  const t = L.loadTask(db, pos[0] ?? die('edit <id> …'));
  const ch = {};
  for (const k of ['title', 'type', 'priority']) if (o[k]) ch[k] = one(o, k);
  for (const [opt, field] of [['parent', 'parent'], ['assignee', 'assignee'], ['size', 'size'], ['initiative', 'initiative'], ['origin', 'origin']]) if (o[opt]) ch[field] = none(one(o, opt));
  if (o.tags) ch.tags = many(o, 'tags');
  if (o.deps) ch.depends_on = none(one(o, 'deps')) === null ? [] : many(o, 'deps');
  if (o.docs) ch.docs = many(o, 'docs');
  if (o['add-tag'] || o['rm-tag']) {
    const rm = many(o, 'rm-tag');
    ch.tags = [...new Set([...(ch.tags ?? t.fields.tags), ...many(o, 'add-tag')])].filter((x) => !rm.includes(x));
  }
  const { diff } = L.editTask(db, t.fields.id, ch, { by: by(o) });
  console.log(Object.keys(diff).length ? `~ ${t.fields.id} ${Object.keys(diff).join(', ')}` : 'nothing changed');
}

function cmdShow(db, o, pos) {
  const t = L.loadTask(db, pos[0] ?? die('show <id>'));
  const ev = L.readEvents(db, t.fields.id);
  if (o.json) return console.log(JSON.stringify({ ...L.taskJson(t), history: ev }, null, 2));
  console.log(fs.readFileSync(path.join(db.root, t.file), 'utf8').trimEnd());
  const next = L.allowedTargets(db, t.fields.status);
  console.log(`\n── next statuses: ${next.join(', ') || '—'}`);
  console.log('── history');
  ev.forEach((e) => console.log(fmtEvent(e)));
}

function cmdInitiative(db, o, pos) {
  const [sub = 'list', id, ...words] = pos;
  const list = (db.wf.initiatives ??= []);
  const find = () => L.initiativeDef(db, id) ?? die(`initiative "${id}" not found; initiatives: ${list.map((x) => x.id).join(', ') || '—'}`);
  const place = (x, before) => {
    if (before == null) return;
    list.splice(list.indexOf(x), 1);
    const at = before === 'last' ? -1 : list.findIndex((y) => y.id === before);
    if (before !== 'last' && at < 0) die(`--before: initiative "${before}" not found`);
    list.splice(at < 0 ? list.length : at, 0, x);
  };
  if (sub === 'list') {
    const ts = L.loadAll(db).tasks;
    if (!list.length) return console.log('(no initiatives: tasks initiative add <id> <title>)');
    for (const x of list) {
      const mine = ts.filter((t) => t.fields.initiative === x.id), open = mine.filter((t) => !L.isClosed(db, t.fields.status)).length;
      console.log(`${pad(x.id, 12)} ${pad(x.title, 28)} ${pad(`${open} open / ${mine.length}`, 14)}${x.closed ? ' closed' : ''}${x.goal ? `  ${x.goal}` : ''}`);
    }
    const none = ts.filter((t) => !t.fields.initiative && !L.isClosed(db, t.fields.status)).length;
    if (none) console.log(`${pad('—', 12)} ${pad('без инициативы', 28)} ${none} open`);
    return;
  }
  if (!id) die(`initiative ${sub} <id> …`);
  if (sub === 'order') {
    // the named ones first, in that order; the rest keep theirs after them
    L.orderInitiatives(db, [id, ...words].flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean));
    return console.log(`~ initiatives ordered: ${db.wf.initiatives.map((x) => x.id).join(', ')}`);
  } else if (sub === 'add') {
    if (!/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(id)) die(`initiative id "${id}" must be a bare word (latin letters, digits, - _ .)`);
    if (L.initiativeDef(db, id)) die(`initiative "${id}" already exists`);
    if (!words.join(' ').trim()) die('initiative add <id> <title…>');
    const x = { id, title: words.join(' ').trim(), ...(one(o, 'goal') ? { goal: one(o, 'goal') } : {}) };
    list.push(x);
    place(x, one(o, 'before'));
  } else if (sub === 'edit') {
    const x = find();
    if (o.title) x.title = one(o, 'title');
    if (o.goal) { const g = none(one(o, 'goal')); if (g) x.goal = g; else delete x.goal; }
    place(x, one(o, 'before'));
  } else if (sub === 'close' || sub === 'open') {
    const x = find();
    if (sub === 'close') x.closed = true; else delete x.closed;
  } else die('initiative list | add | edit | order | close | open');
  L.saveWorkflow(db);
  console.log(`~ initiative ${id} (${sub})`);
}

function cmdAspect(db, o, pos) {
  const [sub = 'list', tag, ...words] = pos;
  const list = (db.wf.aspects ??= []);
  if (sub === 'list') return list.length ? list.forEach((a) => console.log(`#${pad(a.tag, 12)} ${a.title}`)) : console.log('(no aspects: tasks aspect add <tag> <title>)');
  if (!tag) die(`aspect ${sub} <tag> …`);
  if (sub === 'add') {
    if (list.some((a) => a.tag === tag)) die(`aspect #${tag} already exists`);
    if (!words.join(' ').trim()) die('aspect add <tag> <title…>');
    list.push({ tag, title: words.join(' ').trim() });
  } else if (sub === 'rm') {
    if (!list.some((a) => a.tag === tag)) die(`aspect #${tag} not found`);
    db.wf.aspects = list.filter((a) => a.tag !== tag);
  } else die('aspect list | add | rm');
  L.saveWorkflow(db);
  console.log(`~ aspect #${tag} (${sub})`);
}

const MARK = { red: '✗', minor: '~', stale: '·', ok: '✓' };

function cmdCode(db, o, pos) {
  const st = C.codeState(db);
  if (pos[0]) {
    const f = st.files[pos[0]] ?? die(`${pos[0]} is not in the scanned code (see .tasks/project.json code.include)`);
    if (o.json) return console.log(JSON.stringify(f, null, 2));
    console.log(`${MARK[f.status]} ${f.path}  ${f.lines} lines  area ${f.area ?? '—'}  ${f.commit ? `last commit ${f.commit} ${f.date.slice(0, 10)}` : 'not committed'}${f.dirty ? '  (modified)' : ''}`);
    console.log(f.audit ? `audit: ${f.audit.audit} ${f.audit.ts.slice(0, 10)} ${f.audit.status}${f.changedSinceAudit ? ' — changed since' : ''}${f.audit.notes ? ` — ${f.audit.notes}` : ''}` : 'audit: never');
    if (f.guards) console.log(`guardians: ${C.guardianMarks(st.guardians, f.guards)}${st.guardians.check && st.guardians.stale ? `  (marks of ${st.guardians.head ?? 'an earlier run'}: stale)` : ''}${st.guardians.list.filter((g) => !f.guards[g.id]).map((g) => `, «${g.name}» не читал`).join('')}`);
    else if (st.guardians?.list.length) console.log(`guardians: ${st.guardians.list.map((g) => `«${g.name}» не читал`).join(', ')}`);
    for (const [gid, m] of Object.entries(f.guards ?? {})) if (m.audit && m.notes) console.log(`  «${st.guardians.list.find((g) => g.id === gid)?.name ?? gid}» (${m.audit} ${m.ts.slice(0, 10)}): ${m.notes}`);
    f.reasons.forEach((r) => console.log(`  ✗ [${r.kind}] ${r.text}${r.ref ? `  (${r.ref}${r.task ? ` → ${r.task}` : ''})` : ''}`));
    f.dups.forEach((d) => console.log(`  ≡ ${d.lines} lines ${d.at.join('-')} = ${d.with}:${d.there.join('-')}`));
    console.log(`  imports: ${f.imports.join(', ') || '—'}\n  imported by: ${f.importers.join(', ') || (f.entry ? '(entry)' : '— nobody')}`);
    return;
  }
  if (o.json) return console.log(JSON.stringify(st, null, 2));
  const s = st.summary;
  console.log(`${st.project} @ ${st.head ?? '—'}: ${s.files} files, ${s.lines} lines — ${s.red} red, ${s.minor} minor (low findings only), ${s.stale} not audited or changed since, ${s.ok} ok; ${s.openFindings} open findings, ${s.dups} copied blocks, ${s.orphans} orphans; last audit ${s.lastAudit?.slice(0, 10) ?? 'never'}`);
  for (const p of st.pillars) console.log(`  pillar ${pad(p.id, 12)} ${p.verdict ? p.verdict.status : 'not audited'}${p.open.length ? `  open: ${p.open.join(', ')}` : ''}`);
  const G = st.guardians;
  if (G) {
    for (const g of G.list) {
      const w = g.sweep;
      const read = w.read || w.stale ? `read ${w.read}/${w.files} files${w.stale ? ` (+${w.stale} changed since)` : ''}, ${w.broken} broken, ${w.findings} open findings (${w.filed} filed); last sweep ${w.last?.slice(0, 10)}` : 'never swept (tasks guardian sweep)';
      console.log(`  guardian ${pad(g.id, 10)} «${g.name}»  ${read}${G.check ? `; check: ${g.violations} violations, ${g.debt} of them known debt` : ''}${g.problems.length ? `  charter: ${g.problems.length} problem(s)` : ''}`);
    }
    if (G.error) console.log(`  ! guardians' check: ${G.error}`);
    else if (G.check) console.log(`  guardians' check \`${G.check}\`: ${G.ran ? 'run now' : G.stale ? `stale (from ${G.head ?? '—'})` : `kept from ${G.at?.slice(0, 16).replace('T', ' ')}`}`);
    for (const e of G.errors) console.log(`  ! ${e}`);
  }
  const want = o.stale ? ['stale'] : o.red ? ['red'] : ['red'];
  for (const f of Object.values(st.files).filter((f) => want.includes(f.status))) {
    console.log(`${MARK[f.status]} ${f.path}`);
    f.reasons.forEach((r) => console.log(`    [${r.kind}] ${cut(r.text, 140)}${r.ref ? `  (${r.ref}${r.task ? ` → ${r.task}` : ''})` : ''}`));
  }
}

function cmdAudit(db, o, pos) {
  const [sub, ...args] = pos;
  if (sub === 'brief') {
    const b = C.auditBrief(db, { tasks: args, files: many(o, 'files'), title: one(o, 'title') ?? '', out: one(o, 'verdict') ?? '', onlyFiles: !!o['only-files'], since: one(o, 'since') ?? '', allPillars: !!o['all-pillars'] });
    if (one(o, 'out')) { fs.writeFileSync(one(o, 'out'), b.text); console.log(`brief → ${one(o, 'out')} (${b.scope.length} files${b.tasks.length ? `, tasks ${b.tasks.join(', ')}` : ''})`); }
    else process.stdout.write(b.text);
    return;
  }
  if (sub === 'add') {
    const raw = o.stdin ? stdin() : one(o, 'file') ? fs.readFileSync(one(o, 'file'), 'utf8') : die('audit add --file verdict.json | --stdin');
    const a = C.addAudit(db, JSON.parse(raw));
    console.log(`+ ${a.id} "${a.title}": ${Object.keys(a.files ?? {}).length} files, ${(a.findings ?? []).length} findings${Object.keys(a.tasks ?? {}).length ? ', tasks ' + Object.entries(a.tasks).map(([k, v]) => `${k} ${v.verdict}`).join(', ') : ''}`);
    return;
  }
  if (sub === 'list' || !sub) {
    const st = C.codeState(db);
    if (!st.audits.length) return console.log('(no audits)');
    for (const a of st.audits) console.log(`${a.id}  ${a.ts.slice(0, 16).replace('T', ' ')}  ${cut(a.title, 60)}  files ${a.files}, findings ${a.findings}${Object.keys(a.tasks).length ? ', ' + Object.entries(a.tasks).map(([k, v]) => `${k} ${v.verdict}`).join(' ') : ''}`);
    return;
  }
  if (sub === 'show') {
    const a = L.loadAudits(db).find((x) => x.id === String(args[0] ?? '').toUpperCase()) ?? die(`audit ${args[0]} not found`);
    return console.log(JSON.stringify(a, null, 2));
  }
  if (sub === 'task') {
    const id = String(args[0] ?? '').toUpperCase();
    const sweepOf = (f) => f.guardian && C.isSweep(L.loadAudits(db).find((a) => a.id === f.audit));
    const f = C.findings(db).find((x) => x.id === id) ?? die(`finding ${args[0]} not found (A-0001#2)`);
    if (f.task) die(`${id} is already filed as ${f.task}`);
    const t = L.createTask(db, {
      title: f.title, type: f.kind === 'bug' ? 'bug' : 'chore', priority: f.severity === 'high' ? 'p1' : f.severity === 'low' ? 'p3' : 'p2',
      tags: ['debt', f.kind], origin: id,
      description: sweepOf(f)
        ? `Находка хранителя «${L.guardianOf(db, f.guardian)?.name ?? f.guardian}» ${id} при аудите всего проекта (${f.kind}, ${f.severity ?? '—'}${f.rule ? `, правило ${f.rule}` : ''}):\n\n${f.text}\n\nКак правильно через общее место (слово хранителя): ${f.fix ?? '—'}\n\nГде: ${f.files.map((x) => '`' + x + '`').join(', ')}`
        : `Находка аудита ${id} (${f.kind}, ${f.severity ?? '—'}${f.pillar ? `, основа ${f.pillar}` : ''}):\n\n${f.text}\n\nЧто предлагает аудитор: ${f.fix ?? '—'}\n\nГде: ${f.files.map((x) => '`' + x + '`').join(', ')}`,
    }, { by: 'agent' });
    console.log(`+ ${t.fields.id} [${t.fields.status}] ${t.fields.title}  ← ${id}`);
    return;
  }
  die('audit brief | add | list | show | task');
}

function cmdGuardian(db, o, pos) {
  const [sub = 'list', ...args] = pos;
  if (sub === 'list') {
    const gcfg = L.guardiansConfig(db);
    if (!gcfg) return console.log('(no guardians: project.json has no "guardians": see references/guardians.md)');
    const gs = L.loadGuardians(db);
    console.log(`charters: ${gcfg.charters}/  check: ${gcfg.check ?? '—'}`);
    for (const g of gs) {
      console.log(`${pad(g.id, 10)} «${g.name}»  ${g.file}${g.pillar ? `  pillar ${g.pillar}` : ''}`);
      if (g.summary) console.log(g.summary.split('\n').map((l) => '    ' + l).join('\n'));
      g.problems.forEach((p) => console.log(`    ! ${p}`));
    }
    if (!gs.length) console.log('(no charters yet)');
    return;
  }
  if (sub === 'brief') {
    const [gid, tid] = args;
    if (!gid || !tid) die('guardian brief <guardian> <task id> [--draft decision.md] [--out brief.md] [--answer answer.md]');
    const b = C.guardianGroomBrief(db, gid, tid, { draft: one(o, 'draft') ? fs.readFileSync(one(o, 'draft'), 'utf8') : '', out: one(o, 'answer') ?? '' });
    if (one(o, 'out')) { fs.writeFileSync(one(o, 'out'), b.text); console.log(`brief → ${one(o, 'out')} (guardian ${b.guardian}, task ${b.task})`); }
    else process.stdout.write(b.text);
    return;
  }
  if (sub === 'say') {
    const [tid, gid] = args;
    if (!tid || !gid) die('guardian say <task id> <guardian> (--file answer.md | --stdin)');
    const text = o.stdin ? stdin() : one(o, 'file') ? fs.readFileSync(one(o, 'file'), 'utf8') : die('guardian say … --file answer.md | --stdin');
    const t = L.writeGuardianSay(db, tid, gid, text);
    console.log(`~ ${t.fields.id} ## ${L.GUARDIANS}: «${L.guardianOf(db, gid).name}»`);
    return;
  }
  if (sub === 'review') {
    if (!args[0]) die('guardian review <A-0001#2> [--out brief.md] [--verdict v.json]');
    const b = C.guardianReviewBrief(db, args[0], { out: one(o, 'verdict') ?? '' });
    if (one(o, 'out')) { fs.writeFileSync(one(o, 'out'), b.text); console.log(`brief → ${one(o, 'out')} (guardian ${b.guardian}, finding ${b.finding})`); }
    else process.stdout.write(b.text);
    return;
  }
  if (sub === 'add') {
    const raw = o.stdin ? stdin() : one(o, 'file') ? fs.readFileSync(one(o, 'file'), 'utf8') : die('guardian add --file verdict.json | --stdin');
    const r = L.saveGuardianReview(db, JSON.parse(raw));
    console.log(`+ ${r.id} «${L.guardianOf(db, r.guardian).name}» on ${r.finding}: ${r.verdict}`);
    return;
  }
  if (sub === 'show') {
    const r = L.loadGuardianReviews(db).find((x) => x.id === String(args[0] ?? '').toUpperCase()) ?? die(`review ${args[0]} not found`);
    return console.log(JSON.stringify(r, null, 2));
  }
  if (sub === 'sweep') return cmdSweep(db, o, args);
  die('guardian list | brief | say | review | add | show | sweep');
}

// the audit of the whole project by every guardian (references/guardians.md, «Процесс 3»)
function cmdSweep(db, o, args) {
  if (args[0] === 'add') {
    const file = one(o, 'file');
    const r = JSON.parse(o.stdin ? stdin() : file ? fs.readFileSync(file, 'utf8') : die('guardian sweep add --file verdict.json | --stdin'));
    let batch = null; // the batch's files, from the briefs' folder (sweep.json beside the verdict)
    if (file) try { batch = Object.values(JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'sweep.json'), 'utf8')).batches).find((b) => b.guardian === r?.guardian && b.batch === r?.batch) ?? null; } catch {}
    const { rec, guardian: g, unmarked } = C.addSweep(db, r, { batch });
    const ms = Object.values(rec.marks), n = (k) => ms.filter((m) => m.mark === k).length;
    console.log(`+ ${rec.id} «${g.name}»${rec.batch ? ` batch ${rec.batch}` : ''}: ${ms.length} files marked (${n('home')} home, ${n('clean')} clean, ${n('broken')} broken), ${(rec.findings ?? []).length} findings${rec.resolves?.length ? `, resolves ${rec.resolves.join(', ')}` : ''}`);
    (rec.findings ?? []).forEach((f, i) => console.log(`  ${rec.id}#${i + 1} [${f.severity ?? 'medium'}] ${cut(f.title, 70)}  (${f.files.join(', ')})  → tasks audit task ${rec.id}#${i + 1}`));
    if (unmarked.length) console.log(`! ${unmarked.length} file(s) of the batch left unmarked: they stay unread (tasks guardian sweep --rest): ${unmarked.slice(0, 8).join(', ')}${unmarked.length > 8 ? ', …' : ''}`);
    return;
  }
  if (args.length) die('guardian sweep [--guardians a,b] [--rest] [--area id | --files a,b] [--lines 8000] [--dir D] | guardian sweep add --file v.json');
  const opts = { guardians: many(o, 'guardians'), rest: !!o.rest, lines: Number(one(o, 'lines')) || C.SWEEP_LINES, area: one(o, 'area') ?? '', files: many(o, 'files') };
  if (one(o, 'dir')) {
    const list = C.sweepBriefs(db, opts, one(o, 'dir'));
    for (const b of list) console.log(`brief → ${b.brief}  verdict → ${b.verdict}  («${b.name}» ${b.k}/${b.of}: ${b.files} files, ${b.lines} lines; ${b.areas.join(', ')})`);
    console.log(list.length ? `${list.length} brief(s): a fresh agent (not a fork) per brief, «Прочитай бриф <brief> и выполни его в точности»; then tasks guardian sweep add --file <verdict> for each` : '(nothing to read: every file is marked on its current version; drop --rest to read all again)');
    return;
  }
  const plan = C.sweepPlan(db, opts);
  const G = plan.state.guardians;
  for (const { g, batches } of plan.guardians) {
    const w = G.list.find((x) => x.id === g.id).sweep;
    console.log(`«${g.name}» (${g.id}): read ${w.read}/${w.files} files on their current version${w.stale ? `, ${w.stale} changed since` : ''}; ${w.broken} broken, ${w.findings} open findings (${w.filed} filed)${w.last ? `; last sweep ${w.last.slice(0, 10)}` : ''}`);
    const files = batches.reduce((s, b) => s + b.files.length, 0), lines = batches.reduce((s, b) => s + b.lines, 0);
    console.log(`  to read${opts.rest ? ' (--rest)' : ''}: ${files} files, ${lines} lines → ${batches.length} batch(es) of ≤ ${plan.lines} lines`);
    for (const b of batches) console.log(`    ${b.k}/${b.of}: ${b.files.length} files, ${b.lines} lines (${b.areas.join(', ')})`);
  }
  const n = plan.guardians.reduce((s, x) => s + x.batches.length, 0);
  console.log(`${n} agent(s) in all: tasks guardian sweep${opts.rest ? ' --rest' : ''} --dir <scratch>/sweep writes their briefs`);
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = parseArgs(rest);
if (!cmd || cmd === 'help' || opt.help) { console.log(USAGE); process.exit(0); }

try {
  if (cmd === 'init') { cmdInit(opt); process.exit(0); }
  const root = L.findRoot();
  if (!root) die(`no ${L.DIR}/workflow.json here or above — run: node ${path.join(SKILL, 'scripts', 'tasks.mjs')} init`);
  const db = L.openDb(root);
  switch (cmd) {
    case 'add': cmdAdd(db, opt, pos); break;
    case 'list': case 'ls': cmdList(db, opt); break;
    case 'board': cmdBoard(db, opt); break;
    case 'next': { const ts = L.nextTasks(db); ts.length ? ts.forEach((t) => console.log(line(db, t))) : console.log('(nothing ready)'); break; }
    case 'show': cmdShow(db, opt, pos); break;
    case 'check': cmdMove(db, opt, pos, true); break;
    case 'move': case 'mv': cmdMove(db, opt, pos, false); break;
    case 'edit': cmdEdit(db, opt, pos); break;
    case 'section': {
      const [id, name, ...words] = pos;
      if (!id || !name) die('section <id> <name> (<text> | --stdin) | --remove');
      const t = L.writeSection(db, id, name, opt.remove ? '' : opt.stdin ? stdin() : words.join(' '), { append: !!opt.append, replace: !!opt.replace, rm: !!opt.remove, by: by(opt) });
      console.log(`${opt.remove ? '-' : '~'} ${t.fields.id} ## ${name}`);
      break;
    }
    case 'note': {
      const [id, ...words] = pos;
      if (!id || !words.length) die('note <id> <text>');
      console.log(`~ ${L.addNote(db, id, words.join(' '), { by: by(opt) }).fields.id} ## Notes`);
      break;
    }
    case 'ac': {
      const t = L.editAcceptance(db, pos[0] ?? die('ac <id> …'), { add: opt.add ?? [], check: nums(opt, 'check'), uncheck: nums(opt, 'uncheck'), remove: nums(opt, 'rm') }, { by: by(opt) });
      L.checklist(L.sectionText(t, 'Acceptance criteria')).forEach((x, i) => console.log(`  ${i + 1}. [${x.done ? 'x' : ' '}] ${x.text}`));
      break;
    }
    case 'initiative': cmdInitiative(db, opt, pos); break;
    case 'aspect': cmdAspect(db, opt, pos); break;
    case 'history': {
      const ev = L.readEvents(db, pos[0] ? L.normId(db, pos[0]) : null);
      opt.json ? console.log(JSON.stringify(ev, null, 2)) : ev.forEach((e) => console.log(fmtEvent(e)));
      break;
    }
    case 'validate': {
      const { errors, warnings, count } = L.validateDb(db);
      warnings.forEach((w) => console.log(`warn: ${w}`));
      errors.forEach((e) => console.log(`ERROR: ${e}`));
      console.log(`${count} task(s), ${errors.length} error(s), ${warnings.length} warning(s)`);
      if (errors.length) process.exitCode = 1;
      break;
    }
    case 'export': console.log(JSON.stringify(L.exportDb(db), null, 2)); break;
    case 'code': cmdCode(db, opt, pos); break;
    case 'audit': cmdAudit(db, opt, pos); break;
    case 'guardian': cmdGuardian(db, opt, pos); break;
    case 'serve': serve(root, { port: Number(one(opt, 'port') ?? 4747), host: one(opt, 'host') ?? C.loadProject(db).serve.host, open: !!opt.open }); break;
    default: die(`unknown command "${cmd}"\n\n${USAGE}`);
  }
} catch (e) {
  if (e instanceof L.TaskError || e instanceof SyntaxError) die(e.message);
  throw e;
}
