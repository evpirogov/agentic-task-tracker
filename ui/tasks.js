// Tasks: views and statuses, then tags (navigation) → rows grouped by status (content) → the
// task (context). «Что дальше» is read from workflow.json: the forward transition from the
// task's status, its gates checked against the task as it is now.
import { esc, md, inline, dot, label, row, tree, treeHead, props, section, clamp, empty, progress, ago, short, day, stamp, href, withParams, chip, listParam, openSet, store, plural } from './lib.js';
import { D, need } from './data.js';

const SEC_RU = { description: 'Описание', decision: 'Решение', 'acceptance criteria': 'Критерии приёмки', plan: 'План', notes: 'Заметки', result: 'Результат', wiki: 'Вики', guardians: 'Хранители' };
const secRu = (n) => SEC_RU[String(n).toLowerCase()] ?? n;
const meaningful = (s) => String(s ?? '').replace(/<!--[\s\S]*?-->/g, '').trim().length > 0;
const CHECK = /^\s*[-*] \[([ xX])\] (.*)$/;
const checklist = (text) => String(text ?? '').split('\n').map((l) => CHECK.exec(l)).filter(Boolean).map((m) => ({ done: m[1] !== ' ', text: m[2].trim() }));
const sec = (t, name) => { const k = Object.keys(t.sections ?? {}).find((x) => x.toLowerCase() === name.toLowerCase()); return k ? t.sections[k] : ''; };
const WHO = { user: 'пользователь', agent: 'агент', auditor: 'аудитор' };
const WAIT = { accept: 'Приёмка', decide: 'Одобрить решение', question: 'Ответить на вопрос' };
const WAIT_LBL = { accept: 'приёмка', decide: 'решение', question: 'вопрос' };

// ---------------------------------------------------------------- the model
let M = null, Mfor = null;
function model() {
  if (Mfor === D.board) return M;
  const b = D.board, wf = b.workflow;
  const st = new Map(wf.statuses.map((s, i) => [s.id, { ...s, i }]));
  const byId = new Map(b.tasks.map((t) => [t.id, t]));
  const events = new Map();
  for (const e of b.events) (events.get(e.task) ?? events.set(e.task, []).get(e.task)).push(e);
  const sizes = new Map((wf.sizes ?? []).map((s) => (typeof s === 'string' ? [s, s] : [s.id, s.title ?? s.id])));
  const inis = new Map((wf.initiatives ?? []).map((x) => [x.id, x]));
  const m = { wf, st, byId, events, sizes, inis, aspects: wf.aspects ?? [], tasks: b.tasks, audits: b.audits ?? [], ids: new RegExp(`\\b${wf.id_prefix}-\\d+\\b`, 'g') };
  M = m;
  Mfor = D.board;
  for (const t of b.tasks) {
    t._st = st.get(t.status);
    t._closed = t._st?.category === 'done';
    t._plan = checklist(sec(t, 'Plan'));
    t._acc = t.acceptance ?? checklist(sec(t, 'Acceptance criteria'));
    t._notes = parseNotes(sec(t, 'Notes'));
    t._events = events.get(t.id) ?? [];
  }
  for (const t of b.tasks) {
    t._fwd = forward(t);
    t._wait = waiting(t);
    t._next = whatNext(t);
  }
  return m;
}

const matches = (pat, v) => pat === '*' || pat === v || (Array.isArray(pat) && pat.includes(v));
const findTr = (from, to) => M.wf.transitions.find((t) => matches(t.from, from) && matches(t.to, to)) ?? null;
const targets = (from) => M.wf.statuses.map((s) => s.id).filter((to) => to !== from && findTr(from, to));
const stTitle = (id) => M.st.get(id)?.title ?? id;
const closed = (id) => M.byId.get(id)?._closed ?? false;

export function statusTone(s) {
  if (!s) return 'muted';
  if (s.hold) return 'hollow';
  if (s.category === 'done') return /cancel|отмен|wont/i.test(s.id + ' ' + s.title) ? 'muted' : 'green';
  if (s.category === 'todo') return s.id === M.wf.initial_status ? 'muted' : 'ink';
  if (/review/i.test(s.id)) return 'violet';
  if (/qa|audit/i.test(s.id)) return 'blue';
  return 'amber';
}
const prioTone = (p) => ['red', 'amber', '', 'plain'][Math.min(3, Math.max(0, M.wf.priorities.indexOf(p)))];

// Notes: `- date · user: «…»` are the user's words; `- date: …` and `- date from → to: …` the agent's
function parseNotes(text) {
  const items = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    if (/^[-*] /.test(line)) { cur = { raw: line.slice(2) }; items.push(cur); }
    else if (line.trim()) { if (!cur) { cur = { raw: '' }; items.push(cur); } cur.raw += (cur.raw ? '\n' : '') + line.trim(); }
  }
  return items.map(({ raw }) => {
    let m;
    if ((m = /^(\d{4}-\d{2}-\d{2}) · user: ([\s\S]*)$/.exec(raw))) {
      let tx = m[2].trim();
      if (/^«[^«]*»$/.test(tx)) tx = tx.slice(1, -1);
      return { who: 'user', date: m[1], text: tx };
    }
    if ((m = /^(\d{4}-\d{2}-\d{2}) (\S+) → (\S+): ([\s\S]*)$/.exec(raw))) return { who: 'agent', date: m[1], move: { from: m[2], to: m[3] }, text: m[4] };
    if ((m = /^(\d{4}-\d{2}-\d{2}):? ([\s\S]*)$/.exec(raw))) return { who: 'agent', date: m[1], text: m[2] };
    return { who: 'agent', date: null, text: raw };
  });
}

// one gate against the task as it is now: ok true/false, or null when it is checked at the move
function gate(t, gid) {
  const g = M.wf.gates?.[gid];
  if (!g) return { gid, skip: true };
  if ((g.if_types && !g.if_types.includes(t.type)) || (g.if_tags && !g.if_tags.some((x) => t.tags.includes(x)))) return { gid, skip: true };
  const r = { gid, kind: g.kind };
  switch (g.kind) {
    case 'section_nonempty': return { ...r, ok: meaningful(sec(t, g.section)), text: `раздел «${secRu(g.section)}»` };
    case 'checklist_nonempty': return { ...r, ok: checklist(sec(t, g.section)).length > 0, text: `чек-лист в «${secRu(g.section)}»` };
    case 'checklist_complete': {
      const items = checklist(sec(t, g.section)), done = items.filter((x) => x.done).length;
      return { ...r, ok: (items.length > 0 || g.allow_empty === true) && done === items.length, text: items.length ? `отметить «${secRu(g.section)}» (${done}/${items.length})` : `чек-лист в «${secRu(g.section)}»` };
    }
    case 'field_set': { const v = t[g.field]; return { ...r, ok: Array.isArray(v) ? v.length > 0 : v != null && v !== '', text: `поле «${g.field}»` }; }
    case 'deps_done': { const open = t.depends_on.filter((d) => !closed(d)); return { ...r, ok: !open.length, text: `закрыть зависимости ${open.join(', ')}` }; }
    case 'children_done': { const open = M.tasks.filter((x) => x.parent === t.id && !x._closed).map((x) => x.id); return { ...r, ok: !open.length, text: `закрыть подзадачи ${open.join(', ')}` }; }
    case 'note_required': return { gid, skip: true };
    case 'by_user': {
      const kind = /accept/i.test(gid) ? 'accept' : /approv/i.test(gid) ? 'approve' : t._st?.hold || /confirm/i.test(gid) ? 'confirm' : 'user';
      return { ...r, ok: false, user: kind };
    }
    case 'attestation': return { ...r, ok: null, text: { preflight: 'сверка решения с кодом (preflight)', self_check: 'самопроверка автора', architecture_review: 'ревью целостности' }[gid] ?? `аттестация «${gid}»` };
    case 'command': return { ...r, ok: null, text: `проверка «${g.run}»` };
    case 'guardians_asked': return { ...r, ok: null, text: `слово каждого хранителя в «${secRu(g.section ?? 'Guardians')}» (груминг)` };
    case 'audit': {
      const since = enteredAt(t);
      const a = M.audits.filter((x) => x.tasks?.[t.id] && x.ts >= since).at(-1);
      const v = a?.tasks[t.id]?.verdict;
      return { ...r, ok: v === 'pass', audit: a, text: a ? `новый аудит (${a.id}: «${v}»)` : 'независимый аудит' };
    }
    default: return { ...r, ok: null, text: gid };
  }
}
// the workflow asks for a Decision somewhere (the pipeline template); the default one does not
const usesDecision = () => Object.values(M.wf.gates ?? {}).some((g) => /^decision$/i.test(g.section ?? ''));
const enteredAt = (t) => t._events.filter((e) => (e.type === 'status' || e.type === 'created') && e.to === t.status).at(-1)?.ts ?? '';

// the move that takes the task forward in the workflow (not the "from anywhere" ones like cancel)
function forward(t) {
  if (t._closed) return null;
  const s = t._st;
  const to = targets(t.status).filter((x) => M.st.get(x).i > (s?.i ?? -1) && findTr(t.status, x).from !== '*').sort((a, b) => M.st.get(a).i - M.st.get(b).i)[0];
  if (!to) return null;
  const gs = (findTr(t.status, to).gates ?? []).map((g) => gate(t, g)).filter((g) => !g.skip);
  return { to, gs, miss: gs.filter((g) => g.ok === false && !g.user), user: gs.find((g) => g.user), later: gs.filter((g) => g.ok === null) };
}

function waiting(t) {
  if (t._closed || t._st?.hold) return null;
  const last = t._notes.at(-1);
  if (last?.who === 'agent' && (last.text.split('\n').some((l) => l.trim().endsWith('?')) || (last.move && last.move.to === M.wf.initial_status && M.st.get(last.move.from)?.i > M.st.get(last.move.to)?.i))) return 'question';
  const f = t._fwd;
  if (/review/i.test(t.status) || (f?.user?.user === 'accept' && !f.miss.length)) return 'accept';
  if (t.status === M.wf.initial_status && meaningful(sec(t, 'Decision'))) return 'decide';
  return null;
}

const USER_NEED = { accept: 'приёмка пользователя', approve: 'одобрение пользователя', confirm: 'решение пользователя', user: 'решение пользователя' };
const USER_WAIT = { accept: 'ждёт приёмки пользователя', approve: 'ждёт одобрения решения пользователем', confirm: 'отложена: вернуть в работу может только пользователь', user: 'ждёт решения пользователя' };
function whatNext(t) {
  const n = whatNext0(t);
  // work in progress: how far the plan is, before what the next move needs
  const open = t._plan.filter((x) => !x.done).length;
  if (n.tone !== 'wait' && t._st?.category === 'active' && open) n.text = `план ${t._plan.length - open}/${t._plan.length}, ${n.text}`;
  return n;
}
function whatNext0(t) {
  if (t._closed) return { tone: 'done', text: statusTone(t._st) === 'muted' ? 'отменена' : 'закрыта' };
  if (t._wait === 'question') return { tone: 'wait', text: 'ждёт ответа пользователя на вопрос исполнителя' };
  const f = t._fwd;
  if (!f) return { tone: '', text: 'переходов вперёд нет' };
  const to = `«${stTitle(f.to)}»`;
  if (!f.miss.length && f.user) return { tone: 'wait', text: USER_WAIT[f.user.user] };
  if (!f.miss.length && t._wait === 'accept') return { tone: 'wait', text: 'ждёт приёмки пользователя' };
  if (f.miss.length === 1 && f.miss[0].kind === 'audit') return { tone: '', text: f.miss[0].audit ? `аудит ${f.miss[0].audit.id} не пройден: исправить и отдать на новый аудит` : 'ждёт независимого аудита' };
  if (f.miss.length) return { tone: '', text: `для ${to} нужно: ${[...f.miss.map((g) => g.text), f.user && USER_NEED[f.user.user]].filter(Boolean).join(', ')}` };
  const later = f.later.map((g) => g.text).join(', ');
  if (t._st?.category === 'todo' && M.st.get(f.to)?.category === 'active') return { tone: '', text: `готова к работе${later ? `; при старте — ${later}` : ''}` };
  return { tone: '', text: `дальше ${to}${later ? `; при переходе — ${later}` : ''}` };
}

export function waitingCount() { return D.board ? model().tasks.filter((t) => t._wait).length : 0; }

// ---------------------------------------------------------------- views
const isWork = (t) => t._st?.category === 'active' && t._wait !== 'accept' && !/review/i.test(t.status);
function views() {
  const m = model();
  return {
    mine: { title: 'Ждёт меня', list: m.tasks.filter((t) => t._wait), by: 'wait' },
    work: { title: 'В работе', list: m.tasks.filter(isWork), by: 'status' },
    all: { title: 'Все задачи', list: m.tasks, by: 'status' },
  };
}
function viewOf(v) {
  const m = model();
  const vs = views();
  if (vs[v]) return vs[v];
  if (v?.startsWith('s:')) { const id = v.slice(2); return { title: stTitle(id), list: m.tasks.filter((t) => t.status === id), by: 'none', status: id }; }
  if (v?.startsWith('t:')) { const tag = v.slice(2); return { title: `#${tag}`, list: m.tasks.filter((t) => t.tags.includes(tag)), by: 'status' }; }
  if (v?.startsWith('i:')) { const id = v.slice(2); return { title: iniTitle(id === '-' ? null : id), list: m.tasks.filter((t) => (t.initiative ?? '-') === id), by: 'status' }; }
  return vs.all;
}

function navHtml(r) {
  const m = model(), v = r.q.get('v') ?? 'all', vs = views();
  const f = r.navq.trim().toLowerCase();
  const hit = (s) => !f || s.toLowerCase().includes(f);
  const lay = LAYOUTS.includes(r.q.get('layout')) ? r.q.get('layout') : null;
  const node = (key, labelText, list, extra = {}) => ({ key, label: labelText, href: href('/tasks', { v: key === 'all' ? null : key, layout: lay }), meta: list.length || '', ...extra });
  const top = [node('mine', 'Ждёт меня', vs.mine.list, { dot: '' }), node('work', 'В работе', vs.work.list), node('all', 'Все задачи', vs.all.list.filter((t) => !t._closed), { meta: `${vs.all.list.filter((t) => !t._closed).length}` })].filter((n) => hit(n.label));
  const order = [...m.wf.statuses].sort((a, b) => (a.category === 'done') - (b.category === 'done'));
  const sts = order.map((s) => { const n = m.tasks.filter((t) => t.status === s.id).length; return node('s:' + s.id, s.title, Array(n), { dot: dot(statusTone(M.st.get(s.id))), muted: s.category === 'done' || s.hold, meta: n || '' }); }).filter((n) => hit(n.label));
  const tags = new Map();
  for (const t of m.tasks) if (!t._closed) for (const g of t.tags) tags.set(g, (tags.get(g) ?? 0) + 1);
  const tagNodes = [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g, n]) => ({ key: 't:' + g, label: g, href: href('/tasks', { v: 't:' + g, layout: lay }), meta: n })).filter((n) => hit(n.label));
  const vq = r.q.get('v');
  const layouts = [
    { key: 'layout:board', label: 'Доска', href: href('/tasks', { v: vq }), cls: lay ? '' : 'cur', html: `${ICON_BOARD}<span>Доска</span>` },
    m.inis.size && { key: 'layout:lanes', label: 'Инициативы', href: href('/tasks', { v: vq, layout: 'lanes' }), cls: lay === 'lanes' ? 'cur' : '', html: `${ICON_LANES}<span>Инициативы</span>` },
    { key: 'layout:list', label: 'Список', href: href('/tasks', { v: vq, layout: 'list' }), cls: lay === 'list' ? 'cur' : '', html: `${ICON_LIST}<span>Список</span>` },
  ].filter((n) => n && hit(n.label));
  const iniNodes = m.inis.size ? [...lanes(m.tasks)].filter(([, list]) => list.some((t) => !t._closed)).map(([x, list]) => node('i:' + (x?.id ?? '-'), iniTitle(x?.id ?? null), list, { meta: list.filter((t) => !t._closed).length })).filter((n) => hit(n.label)) : [];
  const open = openSet('tasks');
  if (f) open.add('tags');
  let out = (layouts.length ? treeHead('Виды') + tree(layouts, {}) : '') + (top.length ? treeHead('Фильтр') + tree(top, { sel: v }) : '');
  if (iniNodes.length) out += treeHead('Инициативы') + tree(iniNodes, { sel: v });
  if (sts.length) out += treeHead('Статусы') + tree(sts, { sel: v });
  if (tagNodes.length) out += tree([{ key: 'tags', label: 'Теги', meta: tags.size, children: tagNodes, forceOpen: !!f || v.startsWith('t:'), cls: 'th' }], { open, sel: v });
  return out || '<div class="empty">Ничего не найдено</div>';
}

const sizeTitle = (s) => M.sizes.get(s) ?? s;
function taskRow(t, extra = '') {
  const plan = t._plan.length ? progress(t._plan.filter((x) => x.done).length, t._plan.length, 'План') : '';
  const html = `${dot(statusTone(t._st), t._st?.title ?? t.status)}<span class="id">${esc(t.id)}</span><span class="ttl">${esc(t.title)}</span>${extra}`
    + `<span class="slot sz">${t.size ? label(sizeTitle(t.size)) : ''}</span><span class="slot pr">${label(t.priority, prioTone(t.priority))}</span>`
    + `<span class="slot pl">${plan}</span><span class="meta up" title="Обновлена ${esc(stamp(t.updated))}">${esc(short(t.updated))}</span>`;
  return row({ href: withParams({ sel: t.id, full: null }), key: t.id, sel: new URLSearchParams(location.search).get('sel') === t.id, html, cls: t._closed ? 'muted' : '', open: withParams({ sel: t.id, full: 1 }) });
}

function filtered(list, r) {
  const q = (r.q.get('q') ?? '').trim().toLowerCase();
  const types = listParam('type'), sizes = listParam('size'), asp = listParam('aspect');
  return list.filter((t) => (!types.length || types.includes(t.type)) && (!sizes.length || sizes.includes(t.size)) && (!asp.length || asp.some((x) => t.tags.includes(x)))
    && (!q || `${t.id} ${t.title} ${t.tags.join(' ')}`.toLowerCase().includes(q)));
}
const sortRows = (a, b) => M.wf.priorities.indexOf(a.priority) - M.wf.priorities.indexOf(b.priority) || (a.updated < b.updated ? 1 : -1);

function groupHtml(key, title, list, { tone, fold, extra } = {}) {
  if (!list.length) return '';
  const folded = fold && store.get('fold:' + key, true);
  return `<div class="grp${fold ? ' fold' : ''}" data-fold="${fold ? esc(key) : ''}">${fold ? `<i class="caret${folded ? '' : ' down'}"></i>` : ''}${tone ? dot(tone) : ''}<span>${esc(title)}</span><span class="sub2 meta">${list.length}</span></div>`
    + (folded ? '' : list.sort(sortRows).map((t) => taskRow(t, extra?.(t) ?? '')).join(''));
}

function listBody(view, r) {
  const list = filtered(view.list, r);
  if (!view.list.length) return empty(view === views().mine ? 'Сейчас от вас ничего не ждут: здесь появятся задачи на приёмке, решения на одобрение и вопросы исполнителя.' : 'Задач нет.');
  if (!list.length) return empty('Под фильтр ничего не попало.');
  if (view.by === 'wait') return ['accept', 'decide', 'question'].map((w) => groupHtml('w:' + w, WAIT[w], list.filter((t) => t._wait === w), { extra: () => '' })).join('');
  if (view.by === 'status') return M.wf.statuses.slice().sort((a, b) => (a.category === 'done') - (b.category === 'done')).map((s) => groupHtml('s:' + s.id, s.title, list.filter((t) => t.status === s.id), { tone: statusTone(M.st.get(s.id)), fold: s.category === 'done' || s.hold })).join('');
  return list.sort(sortRows).map((t) => taskRow(t)).join('');
}

// ---------------------------------------------------------------- the board
// Columns of the open statuses fill the width; held and closed ones fold into 32 px strips.
function card(t, selId) {
  const planDone = t._plan.filter((x) => x.done).length;
  const html = `<div class="ct">${esc(t.id)}<span class="cb2">${t.size ? label(sizeTitle(t.size)) : ''}${label(t.priority, prioTone(t.priority))}</span></div>`
    + `<div class="cn">${esc(t.title)}</div>`
    + (t._wait ? `<div class="cw">${label(WAIT_LBL[t._wait], 'amber')}</div>` : '')
    + (t._plan.length ? `<div class="cp">${progress(planDone, t._plan.length, 'План')}</div>` : '')
    + `<div class="cf"><span class="tg">${t.tags.slice(0, 3).map((g) => `#${esc(g)}`).join(' ')}</span><span class="meta" title="Обновлена ${esc(stamp(t.updated))}">${esc(short(t.updated))}</span></div>`;
  return `<a class="card${selId === t.id ? ' sel' : ''}${t._closed ? ' muted' : ''}" href="${esc(withParams({ sel: t.id, full: null }))}" data-key="${esc(t.id)}" data-row data-open="${esc(withParams({ sel: t.id, full: 1 }))}">${html}</a>`;
}
function boardBody(view, r, v) {
  const list = filtered(view.list, r);
  const only = v.startsWith('s:') ? v.slice(2) : null;
  const sel = r.sel;
  const cols = M.wf.statuses.filter((s) => !only || s.id === only).map((s) => {
    const cards = list.filter((t) => t.status === s.id).sort(sortRows);
    const foldable = s.hold || s.category === 'done';
    if (foldable && !only && !cards.length) return '';
    const folded = foldable && !only && store.get('fold:b:' + s.id, true) && !cards.some((t) => t.id === sel);
    const tone = statusTone(M.st.get(s.id));
    if (folded) return `<div class="strip" data-fold="b:${esc(s.id)}" title="${esc(s.title)}: ${cards.length} — развернуть">${dot(tone)}<span class="sn">${esc(s.title)}</span><span class="sc">${cards.length}</span></div>`;
    return `<section class="col${foldable ? ' foldable' : ''}"><div class="colh"${foldable && !only ? ` data-fold="b:${esc(s.id)}" title="Свернуть"` : ''}>${dot(tone)}<span>${esc(s.title)}</span><span class="meta">${cards.length}${s.wip_limit ? ` / ${s.wip_limit}` : ''}</span></div><div class="colb">${cards.map((t) => card(t, sel)).join('')}</div></section>`;
  }).join('');
  return `<div class="board">${cols}</div>`;
}

// ---------------------------------------------------------------- the initiatives
// Rows of the board: one per initiative (the catalog's order, then the tasks without one), the
// columns of the board in each; a closed initiative shows only while it still has open tasks.
const LAYOUTS = ['list', 'lanes'];
const iniTitle = (id) => (id == null ? 'Без инициативы' : M.inis.get(id)?.title ?? id);
function lanes(list) {
  const out = new Map([...M.inis.values()].map((x) => [x, []]));
  const none = [];
  for (const t of list) (M.inis.has(t.initiative) ? out.get(M.inis.get(t.initiative)) : none).push(t);
  out.set(null, none);
  return [...out].filter(([x, l]) => l.length && (!x?.closed || l.some((t) => !t._closed)));
}
function lanesBody(view, r) {
  const list = filtered(view.list, r);
  if (!list.length) return empty(view.list.length ? 'Под фильтр ничего не попало.' : 'Задач нет.');
  const sel = r.sel;
  const cols = M.wf.statuses.map((s) => {
    const foldable = s.hold || s.category === 'done';
    const n = list.filter((t) => t.status === s.id).length;
    return { s, n, tone: statusTone(M.st.get(s.id)), skip: foldable && !n, folded: foldable && store.get('fold:b:' + s.id, true) && !list.some((t) => t.status === s.id && t.id === sel), foldable };
  }).filter((c) => !c.skip);
  const minW = cols.reduce((w, c) => w + (c.folded ? 32 : 180), 0);
  const head = cols.map((c) => (c.folded
    ? `<div class="strip hd" data-fold="b:${esc(c.s.id)}" title="${esc(c.s.title)}: ${c.n} — развернуть">${dot(c.tone)}<span class="sc">${c.n}</span></div>`
    : `<div class="col"><div class="colh"${c.foldable ? ` data-fold="b:${esc(c.s.id)}" title="Свернуть"` : ''}>${dot(c.tone)}<span>${esc(c.s.title)}</span><span class="meta">${c.n}</span></div></div>`)).join('');
  const rows = lanes(list).map(([x, ts]) => {
    const key = 'l:' + (x?.id ?? '-');
    const open = store.get('fold:' + key, true) || ts.some((t) => t.id === sel);
    const n = ts.filter((t) => !t._closed).length;
    const cells = cols.map((c) => {
      const cards = ts.filter((t) => t.status === c.s.id).sort(sortRows);
      return c.folded ? `<div class="strip" data-fold="b:${esc(c.s.id)}" title="${esc(c.s.title)}: ${cards.length}"><span class="sc">${cards.length || ''}</span></div>`
        : `<div class="col"><div class="colb">${cards.map((t) => card(t, sel)).join('')}</div></div>`;
    }).join('');
    const drag = x ? ` draggable="true" data-lane="${esc(x.id)}"` : '';
    return `<div class="lane"${drag}><div class="laneh" data-fold="${esc(key)}" title="${open ? 'Свернуть' : 'Развернуть'}">${x ? `<span class="grip" title="Перетащите ряд выше или ниже">${ICON_GRIP}</span>` : '<span class="grip"></span>'}<i class="caret${open ? ' down' : ''}"></i><b>${esc(iniTitle(x?.id ?? null))}</b>${x?.closed ? label('закрыта') : ''}${x?.goal ? `<span class="goal">${esc(x.goal)}</span>` : ''}<span class="meta">${n} открыто · ${ts.length - n} закрыто</span></div>${open ? `<div class="lrow">${cells}</div>` : ''}</div>`;
  }).join('');
  return `<div class="lanes" style="min-width:${minW}px"><div class="lrow lhd">${head}</div>${rows}</div>`;
}

function headHtml(view, r, lay) {
  const board = lay === 'board';
  const m = model(), vs = views();
  const open = m.tasks.filter((t) => !t._closed);
  const hot = open.filter((t) => M.wf.priorities.indexOf(t.priority) <= 1);
  const kpi = (n, text, to, tone = '') => `<a class="kpi ${n ? tone : ''}" href="${esc(to)}"><b>${n}</b>${esc(text)}</a>`;
  const shown = filtered(view.list, r).length;
  const bar = `<div class="bar">${NAV_BTN}<h1>${{ board: 'Доска', lanes: 'Инициативы', list: 'Список' }[lay]}${view.title !== vs.all.title ? ` <span class="h1sub">· ${esc(view.title)}</span>` : ''}</h1><span class="cnt">${shown === view.list.length ? shown : `${shown} из ${view.list.length}`}</span>`
    + `<span class="kpis">${kpi(vs.mine.list.length, 'ждёт меня', withParams({ v: 'mine', sel: null }), 'amber')}${kpi(vs.work.list.length, 'в работе', withParams({ v: 'work', sel: null }))}${kpi(open.length, 'открыто', withParams({ v: null, sel: null }))}${kpi(hot.length, `${M.wf.priorities.slice(0, 2).join('/')} открыто`, withParams({ v: null, sel: null }), 'red')}${kpi(m.tasks.length - open.length, 'закрыто', withParams({ v: null, sel: null }))}</span></div>`;
  const types = new Map(), sizes = new Map();
  for (const t of view.list) { types.set(t.type, (types.get(t.type) ?? 0) + 1); if (t.size) sizes.set(t.size, (sizes.get(t.size) ?? 0) + 1); }
  const tsel = listParam('type'), ssel = listParam('size');
  const tools = `<div class="tools"><input type="search" id="tq" placeholder="Поиск: id, заголовок, тег" value="${esc(r.q.get('q') ?? '')}" autocomplete="off">`
    + (types.size > 1 ? `<span class="tsep" title="Тип"></span>${M.wf.types.filter((x) => types.has(x)).map((x) => chip('type', x, x, types.get(x), tsel.includes(x))).join('')}` : '')
    + (sizes.size > 1 ? `<span class="tsep" title="Размер"></span>${[...M.sizes.keys()].filter((x) => sizes.has(x)).map((x) => chip('size', x, sizeTitle(x), sizes.get(x), ssel.includes(x))).join('')}` : '')
    + (M.aspects.length ? `<span class="tsep" title="Аспект: качество поперёк инициатив"></span>${M.aspects.map((a) => chip('aspect', a.tag, a.title, view.list.filter((t) => t.tags.includes(a.tag)).length, listParam('aspect').includes(a.tag))).join('')}` : '')
    + '</div>';
  return bar + tools;
}

// ---------------------------------------------------------------- the task
const mdOpts = () => ({ ids: M.ids, quotes: true, code: codeHref });
function codeHref(c) {
  const p = c.replace(/:\d+(-\d+)?$/, '');
  if (D.code?.files?.[p]) return href('/code/files/' + p, { sel: p });
  return null;
}
function reply(n, lines, full) {
  const who = n.who === 'user' ? 'Пользователь' : 'Агент';
  const mv = n.move ? ` · ${esc(stTitle(n.move.from))} → ${esc(stTitle(n.move.to))}` : '';
  const body = `<div class="md small">${md(n.text, mdOpts())}</div>`;
  return `<div class="reply ${n.who}"><div class="reply-h"><b>${who}</b><span>${n.date ? esc(day(n.date)) : ''}${mv}</span></div>${full ? body : clamp(body, lines)}</div>`;
}
function checks(items) {
  return items.map((x) => `<div class="check${x.done ? ' done' : ''}"><i class="cb"></i><span>${inline(x.text, mdOpts())}</span></div>`).join('');
}
function evText(e) {
  switch (e.type) {
    case 'created': return `создана → ${esc(stTitle(e.to))}`;
    case 'status': return `${esc(stTitle(e.from))} → <b>${esc(stTitle(e.to))}</b>${e.forced ? ' <span class="lbl red">в обход проверок</span>' : ''}${e.note ? `: ${inline(e.note.slice(0, 220) + (e.note.length > 220 ? '…' : ''), mdOpts())}` : ''}`;
    case 'edit': return `правка: ${esc(Object.keys(e.changes ?? {}).join(', '))}`;
    case 'section': return `${e.mode === 'append' ? 'дополнен' : 'записан'} раздел «${esc(secRu(e.section))}»`;
    case 'acceptance': return `критерии: ${[e.add && `+${e.add.length}`, e.check && `отмечено ${e.check.join(', ')}`, e.uncheck && `снято ${e.uncheck.join(', ')}`, e.remove && `удалено ${e.remove.join(', ')}`].filter(Boolean).join(', ')}`;
    case 'audit': return `аудит <a href="${esc(href('/code/audits', { sel: e.audit }))}">${esc(e.audit)}</a>: ${label(e.verdict, e.verdict === 'pass' ? 'green' : 'red')}`;
    case 'guardian': return e.review ? `хранитель «${esc(e.guardian)}», ревью ${esc(e.review)} по ${esc(e.finding)}: ${label(e.verdict, e.verdict === 'accept' ? 'green' : 'red')}` : `хранитель «${esc(e.guardian)}»: слово в ТЗ`;
    default: return esc(e.type);
  }
}
const sessionHref = (sid, t, at) => href('/session/' + sid, { sel: t.id, at });

function taskBody(t, full) {
  const m = model();
  const L = full ? 0 : 4;
  const dec = sec(t, 'Decision');
  const desc = sec(t, 'Description');
  const userNotes = t._notes.filter((n) => n.who === 'user');
  const lastUser = t._notes.map((n) => n.who).lastIndexOf('user');
  const questions = t._notes.slice(lastUser + 1).filter((n) => n.who === 'agent' && n.text.split('\n').some((l) => l.trim().endsWith('?')));
  const planDone = t._plan.filter((x) => x.done).length, accDone = t._acc.filter((x) => x.done).length;
  const kids = m.tasks.filter((x) => x.parent === t.id);
  const tlink = (id) => { const x = m.byId.get(id); return x ? `<a href="${esc(withParams({ sel: id, full: full ? 1 : null }))}" title="${esc(x.title)}">${dot(statusTone(x._st))} ${esc(id)}</a>` : esc(id); };
  const others = targets(t.status).filter((x) => x !== t._fwd?.to);
  const summ = `<div class="summ">`
    + (dec ? `<div>${clamp(`<div class="md small">${md(dec, mdOpts())}</div>`, full ? 8 : 3)}</div>` : '')
    + props([
      ['Решение', dec || !usesDecision() ? null : `<span class="zero">нет — ${t._closed ? 'не записано' : 'нужен груминг'}</span>`],
      ['План', t._plan.length ? `<span class="inl">${progress(planDone, t._plan.length)}</span>` : null],
      ['Критерии', t._acc.length ? `<span class="inl">${progress(accDone, t._acc.length)}</span>` : null],
      ['Вопросы', questions.length ? questions.map((q) => `<div class="para">${inline(q.text.split('\n').filter((l) => l.trim().endsWith('?')).join(' '), mdOpts())}</div>`).join('') : null],
      ['Инициатива', m.inis.size ? (t.initiative ? `<a href="${esc(href('/tasks', { v: 'i:' + t.initiative, layout: 'lanes' }))}">${esc(iniTitle(t.initiative))}</a>` : '<span class="zero">нет</span>') : null],
      ['Метки', `${label(t.priority, prioTone(t.priority))}${t.size ? label(sizeTitle(t.size)) : ''}${label(t.type)}${t.tags.map((g) => `<a class="lbl" href="${esc(href('/tasks', { v: 't:' + g }))}">#${esc(g)}</a>`).join('')}`],
      ['Родитель', t.parent ? tlink(t.parent) : null],
      ['Подзадачи', kids.length ? kids.map((k) => tlink(k.id)).join(' ') : null],
      ['Зависит от', t.depends_on.length ? t.depends_on.map(tlink).join(' ') : null],
      ['Находка', t.origin ? `<a href="${esc(href('/code/debt', { sel: t.origin }))}">${esc(t.origin)}</a>` : null],
      ['Документы', t.docs?.length ? t.docs.map((d) => `<code>${esc(d)}</code>`).join(' ') : null],
      ['Переходы', others.length || t._fwd ? [t._fwd && `<b>${esc(stTitle(t._fwd.to))}</b>`, ...others.map((x) => esc(stTitle(x)))].filter(Boolean).join(' · ') : null],
      ['Даты', `обновлена ${esc(ago(t.updated))} · создана ${esc(day(t.created))}`],
    ])
    + '</div>';
  const words = (desc ? [reply({ who: 'user', date: t.created?.slice(0, 10), text: desc }, L, full)] : []).concat(userNotes.map((n) => reply(n, L, full))).join('');
  const discussion = t._notes.map((n) => reply(n, full ? 0 : 3, full)).join('');
  const res = sec(t, 'Result');
  const wiki = sec(t, 'Wiki');
  const sessions = new Map();
  for (const e of t._events) if (e.session) { const s = sessions.get(e.session) ?? { id: e.session, from: e.ts, to: e.ts, n: 0 }; s.to = e.ts; s.n++; sessions.set(e.session, s); }
  const hist = `<div class="feed">${t._events.slice().reverse().map((e) => `<div class="ev"><span class="when">${e.session ? `<a href="${esc(sessionHref(e.session, t, e.ts))}" title="Открыть сессию в этот момент">${esc(stamp(e.ts))}</a>` : esc(stamp(e.ts))}</span><span class="what">${evText(e)}</span><span class="who">${esc(WHO[e.by] ?? e.by ?? '')}</span></div>`).join('')}</div>`
    + (sessions.size ? `<div class="thead" style="padding:0">Сессии</div><div class="list">${[...sessions.values()].reverse().map((s) => `<a href="${esc(sessionHref(s.id, t))}"><span class="mono">${esc(s.id.slice(0, 8))}</span><span class="ttl">${esc(stamp(s.from))} – ${esc(stamp(s.to))}</span><span class="meta">${s.n} ${plural(s.n, 'событие', 'события', 'событий')}</span></a>`).join('')}</div>` : '');
  const parts = {
    summ,
    words: section('words', 'Слова пользователя', words, { count: (desc ? 1 : 0) + userNotes.length, open: true }),
    decision: section('decision', 'Решение', dec && `<div class="md small">${md(dec, mdOpts())}</div>`, { open: false }),
    acc: section('acc', 'Критерии приёмки', t._acc.length && checks(t._acc), { count: `${accDone}/${t._acc.length}` }),
    plan: section('plan', 'План', t._plan.length && checks(t._plan), { count: `${planDone}/${t._plan.length}` }),
    talk: section('talk', 'Обсуждение', discussion, { count: t._notes.length, open: false }),
    result: section('result', 'Результат', meaningful(res) && clamp(`<div class="md small">${md(res, mdOpts())}</div>`, 6), { open: true }),
    wiki: section('wiki', t._closed ? 'Вики (перенесено)' : 'Вики (черновик, не принято)', meaningful(wiki) && `<div class="md small">${md(wiki, mdOpts())}</div>`, { open: false }),
    history: section('history', 'История', t._events.length && hist, { count: t._events.length, open: false }),
  };
  if (!full) return parts.summ + parts.words + parts.decision + parts.acc + parts.plan + parts.talk + parts.result + parts.wiki + parts.history;
  // the whole task: its texts in the content as a reading column, the summary stays in the context
  const block = (title, html, n = '') => (html ? `<h2 class="fh">${esc(title)}${n !== '' ? `<span class="cnt">${n}</span>` : ''}</h2>${html}` : '');
  return {
    ctx: parts.summ + parts.acc + parts.plan + parts.history,
    main: `<h1 class="ft">${esc(t.title)}</h1>`
      + block('Слова пользователя', words, (desc ? 1 : 0) + userNotes.length)
      + block('Решение', dec && `<div class="md">${md(dec, mdOpts())}</div>`)
      + block('Обсуждение', discussion, t._notes.length)
      + block('Результат', meaningful(res) && `<div class="md">${md(res, mdOpts())}</div>`)
      + block(t._closed ? 'Вики (перенесено)' : 'Вики (черновик, не принято)', meaningful(wiki) && `<div class="md">${md(wiki, mdOpts())}</div>`),
  };
}

function taskHead(t, full) {
  const n = t._next;
  return `<div class="ch"><div class="top">${dot(statusTone(t._st))}<span class="id">${esc(t.id)}</span><span>${esc(t._st?.title ?? t.status)}</span>${t._wait ? label(WAIT_LBL[t._wait], 'amber') : ''}`
    + `<span class="acts">${full ? `<a class="ibtn" href="${esc(withParams({ full: null }))}" title="Свернуть в панель">${ICON_IN}</a>` : `<a class="ibtn" href="${esc(location.pathname === '/tasks' ? withParams({ full: 1 }) : href('/tasks', { sel: t.id, full: 1 }))}" title="Развернуть задачу на всё содержимое (Enter)">${ICON_OUT}</a>`}<button class="ibtn" data-act="close" title="Закрыть (Esc)">${ICON_X}</button></span></div>`
    + `<h2>${esc(t.title)}</h2><div class="next ${n.tone}"><span class="k">Что дальше</span><b>${esc(n.text)}</b></div></div>`;
}
const ICON_BOARD = '<svg class="vi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2.5" width="3.5" height="11" rx="1"/><rect x="6.25" y="2.5" width="3.5" height="7" rx="1"/><rect x="10.5" y="2.5" width="3.5" height="9" rx="1"/></svg>';
const ICON_LANES = '<svg class="vi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2.5" width="12" height="4.5" rx="1"/><rect x="2" y="9" width="12" height="4.5" rx="1"/></svg>';
const ICON_GRIP = '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="6" cy="4" r="1.2"/><circle cx="10" cy="4" r="1.2"/><circle cx="6" cy="8" r="1.2"/><circle cx="10" cy="8" r="1.2"/><circle cx="6" cy="12" r="1.2"/><circle cx="10" cy="12" r="1.2"/></svg>';
const ICON_LIST = '<svg class="vi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>';
export const NAV_BTN = '<button class="ibtn navbtn" data-act="nav" title="Навигация ([)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg></button>';
const svg = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICON_X = svg('<path d="M4 4l8 8M12 4l-8 8"/>');
const ICON_OUT = svg('<path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9"/>');
const ICON_IN = svg('<path d="M13 3L9 7M9 3.5V7h3.5M3 13l4-4M7 12.5V9H3.5"/>');

// Rows of the initiatives are dragged by their header; the drop sends the new order (the admin's
// one write) and the board comes back through the server's change event.
function bindLaneDrag() {
  if (document.body.dataset.laneDrag) return;
  document.body.dataset.laneDrag = '1';
  let from = null;
  const clear = () => document.querySelectorAll('.lane.drop-above, .lane.drop-below').forEach((el) => el.classList.remove('drop-above', 'drop-below'));
  const target = (e) => { const el = e.target.closest?.('.lane[data-lane]'); return el && el !== from ? el : null; };
  const above = (el, e) => { const b = el.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; };
  document.addEventListener('dragstart', (e) => {
    from = e.target.closest?.('.lane[data-lane]');
    if (!from) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', from.dataset.lane);
    from.classList.add('dragging');
  });
  document.addEventListener('dragover', (e) => {
    const el = from && target(e);
    if (!el) return;
    e.preventDefault();
    clear();
    el.classList.add(above(el, e) ? 'drop-above' : 'drop-below');
  });
  document.addEventListener('drop', async (e) => {
    const el = from && target(e);
    if (!el) return;
    e.preventDefault();
    const ids = [...document.querySelectorAll('.lane[data-lane]')].map((x) => x.dataset.lane).filter((id) => id !== from.dataset.lane);
    ids.splice(ids.indexOf(el.dataset.lane) + (above(el, e) ? 0 : 1), 0, from.dataset.lane);
    clear();
    const res = await fetch('/api/initiatives/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).catch(() => null);
    if (!res?.ok) alert(`Порядок не сохранён: ${res ? await res.text() : 'нет связи с сервером'}`);
  });
  document.addEventListener('dragend', () => { from?.classList.remove('dragging'); from = null; clear(); });
}

// ---------------------------------------------------------------- the view
export default {
  id: 'tasks',
  waitingCount,
  async load() { await need('board'); if (D.project.code) need('code').catch(() => {}); },
  normalize(r) {
    return r.sec === 'tasks' && r.q.get('v') === 'all' ? withParams({ v: null }) : null;
  },
  render(r) {
    model();
    const v = r.q.get('v') ?? 'all';
    const view = viewOf(v);
    const t = r.sel ? M.byId.get(r.sel) : null;
    const full = t && r.q.get('full') === '1';
    const out = { nav: navHtml(r), navSearch: 'Фильтр: статусы, теги', tree: 'tasks', view: 'list:' + v, title: t ? t.id : view.title };
    if (full) {
      const b = taskBody(t, true);
      out.view = 'full:' + t.id;
      out.head = `<div class="bar">${NAV_BTN}<div class="crumbs"><a href="${esc(withParams({ sel: null, full: null }))}">${esc(view.title)}</a><span class="sepr">›</span><b>${esc(t.id)}</b></div><span class="meta">обновлена ${esc(ago(t.updated))}</span></div>`;
      out.body = `<div class="read"><div class="md task-full">${b.main}</div></div>`;
      out.ctx = { key: 'task:' + t.id, head: taskHead(t, true), body: b.ctx };
      return out;
    }
    const lay = LAYOUTS.includes(r.q.get('layout')) && (r.q.get('layout') !== 'lanes' || M.inis.size) ? r.q.get('layout') : 'board';
    out.head = headHtml(view, r, lay);
    out.view = lay + ':' + v;
    out.body = lay === 'board' ? boardBody(view, r, v) : lay === 'lanes' ? lanesBody(view, r) : `<div class="rows">${listBody(view, r)}</div>`;
    out.bodyClass = lay === 'list' ? '' : 'boardwrap';
    if (r.sel) out.ctx = t ? { key: 'task:' + t.id, head: taskHead(t, false), body: taskBody(t, false) } : { key: 'none', head: '', body: empty(`Задачи ${esc(r.sel)} нет.`) };
    return out;
  },
  after(r) {
    bindLaneDrag();
    const q = document.getElementById('tq');
    if (q && !q.dataset.bound) {
      q.dataset.bound = '1';
      let timer;
      q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => window.dispatchEvent(new CustomEvent('tt:go', { detail: { to: withParams({ q: q.value }), replace: true } })), 120); });
    }
  },
  // rows to flash after a live update
  changed(kind, old) {
    if (kind !== 'board' || !old) return [];
    const was = new Map(old.tasks.map((t) => [t.id, t.updated + t.status]));
    return D.board.tasks.filter((t) => was.get(t.id) !== t.updated + t.status).map((t) => t.id);
  },
  model,
  navHtml,
  taskHead,
  taskBody,
};
