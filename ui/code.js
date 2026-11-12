// Code: Overview · Pillars · Debt · Files · Copies · Audits (navigation) → the chosen view
// (content) → a finding, a file, a copy or an audit (context). Debt is grouped by finding.
import { esc, md, inline, dot, label, row, tree, props, section, clamp, empty, ago, day, num, href, withParams, chip, listParam, openSet, store, plural } from './lib.js';
import { D, need, doc } from './data.js';
import tasksView, { statusTone, ICON_X } from './tasks.js';

const SEV = ['high', 'medium', 'low'];
const SEV_RU = { high: 'высокая', medium: 'средняя', low: 'низкая' };
const SEV_TONE = { high: 'red', medium: 'amber', low: '' };
const KIND_RU = { duplicate: 'копия', legacy: 'устаревшее', debt: 'долг', inaccuracy: 'неточность', conflict: 'конфликт', perf: 'скорость', bug: 'ошибка', structure: 'структура', state: 'неявный автомат', pattern: 'правило', guardian: 'хранитель' };
const FILE_TONE = { red: 'red', minor: 'amber', stale: 'muted', ok: 'green' };
const FILE_RU = { red: 'красный', minor: 'жёлтый', stale: 'не проверен', ok: 'зелёный' };
const PIL_TONE = { ok: 'green', risk: 'amber', debt: 'red' };
const PIL_RU = { ok: 'в порядке', risk: 'риск', debt: 'долг' };
const VERDICT_TONE = { ok: 'green', pass: 'green', fail: 'red', debt: 'red', legacy: 'amber', duplicate: 'amber', inaccurate: 'amber' };
const RANK = { red: 3, minor: 2, stale: 1, ok: 0 };
const sev = (f) => f.severity ?? 'medium';
const kindRu = (k) => KIND_RU[k] ?? k;
const navIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>';
const navBtn = `<button class="ibtn navbtn" data-act="nav" title="Навигация">${navIcon}</button>`;

function loc(s) {
  const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(String(s));
  return { path: m[1], from: m[2] ? +m[2] : null, to: m[3] ? +m[3] : m[2] ? +m[2] : null };
}
const fileHref = (p, extra = {}) => href('/code/files/' + p, { sel: p, ...extra });
const findHref = (id) => withParams({ sel: id, line: null });

// ---------------------------------------------------------------- derived
let X = null, Xfor = null;
function model() {
  if (Xfor === D.code) return X;
  const c = D.code;
  const open = c.findings.filter((f) => f.open);
  // the folder tree with the worst status and red count per folder
  const root = { name: '', path: '', dirs: new Map(), files: [], red: 0, worst: 'ok', count: 0, lines: 0 };
  for (const f of Object.values(c.files)) {
    const parts = f.path.split('/');
    let d = root;
    const bump = (n) => { n.count++; n.lines += f.lines; if (f.status === 'red') n.red++; if (RANK[f.status] > RANK[n.worst]) n.worst = f.status; };
    bump(root);
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/') + '/';
      if (!d.dirs.has(parts[i])) d.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [], red: 0, worst: 'ok', count: 0, lines: 0 });
      d = d.dirs.get(parts[i]);
      bump(d);
    }
    d.files.push(f);
  }
  const findingsOf = new Map();
  for (const f of open) for (const l of f.files ?? []) { const p = loc(l).path; (findingsOf.get(p) ?? findingsOf.set(p, new Set()).get(p)).add(f); }
  X = { c, open, root, findingsOf, byId: new Map(c.findings.map((f) => [f.id, f])), audit: new Map(c.audits.map((a) => [a.id, a])), pillar: new Map(c.pillars.map((p) => [p.id, p])) };
  Xfor = D.code;
  return X;
}
function dirAt(path) {
  let d = X.root;
  for (const part of path.split('/').filter(Boolean)) { d = d.dirs.get(part); if (!d) return null; }
  return d;
}

// ---------------------------------------------------------------- navigation
function navHtml(r, selKey) {
  const { c, open: fo, root } = model();
  const f = r.navq.trim().toLowerCase();
  const pillars = c.pillars.map((p) => ({ key: 'pl:' + p.id, label: p.title, href: '/code/pillars/' + p.id, dot: dot(PIL_TONE[p.verdict?.status] ?? 'muted', PIL_RU[p.verdict?.status] ?? 'нет вердикта'), meta: p.open.length || '' }));
  const debt = SEV.map((s) => {
    const list = fo.filter((x) => sev(x) === s);
    const kinds = [...new Set(list.map((x) => x.kind))].sort();
    return { key: 'debt:' + s, label: SEV_RU[s][0].toUpperCase() + SEV_RU[s].slice(1), href: '/code/debt/' + s, dot: dot(SEV_TONE[s] || 'muted'), meta: list.length, children: kinds.map((k) => ({ key: `debt:${s}:${k}`, label: kindRu(k), href: `/code/debt/${s}/${k}`, meta: list.filter((x) => x.kind === k).length })) };
  }).filter((n) => n.meta);
  const dirNode = (d) => ({
    key: 'd:' + d.path, label: d.name, href: '/code/files/' + d.path, dot: dot(FILE_TONE[d.worst]), meta: d.red ? `<span style="color:var(--red)">${d.red}</span>` : '', title: d.path,
    children: [...[...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(dirNode), ...d.files.sort((a, b) => a.path.localeCompare(b.path)).map((x) => ({ key: 'f:' + x.path, label: x.path.split('/').pop(), href: fileHref(x.path), dot: dot(FILE_TONE[x.status], FILE_RU[x.status]), title: x.path }))],
  });
  const files = [...root.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(dirNode).concat(root.files.map((x) => ({ key: 'f:' + x.path, label: x.path, href: fileHref(x.path), dot: dot(FILE_TONE[x.status]), title: x.path })));
  let nodes = [
    { key: 'overview', label: 'Обзор', href: '/code' },
    c.pillars.length && { key: 'pillars', label: 'Основы', href: '/code/pillars', meta: c.pillars.length, children: pillars },
    { key: 'debt', label: 'Долг', href: '/code/debt', meta: fo.length, children: debt },
    { key: 'files', label: 'Файлы', href: '/code/files', meta: c.summary.files, children: files },
    { key: 'dups', label: 'Копии', href: '/code/dups', meta: c.dups.length },
    { key: 'audits', label: 'Аудиты', href: '/code/audits', meta: c.audits.length },
  ].filter(Boolean);
  let open = openSet('code');
  if (!store.get('open:code', null)) { open = new Set(['pillars', 'debt']); store.set('open:code', [...open]); }
  // the selected node's ancestors
  const anc = (ns, path = []) => { for (const n of ns) { if (n.key === selKey) return path; if (n.children) { const p = anc(n.children, [...path, n.key]); if (p) return p; } } return null; };
  for (const k of anc(nodes) ?? []) open.add(k);
  if (f) {
    const keep = (ns) => ns.map((n) => { const kids = n.children ? keep(n.children) : []; return n.label.toLowerCase().includes(f) || (n.title ?? '').toLowerCase().includes(f) || kids.length ? { ...n, children: kids.length ? kids : null, forceOpen: kids.length > 0 } : null; }).filter(Boolean);
    nodes = keep(nodes);
    if (!nodes.length) return '<div class="empty">Ничего не найдено</div>';
  }
  return tree(nodes, { open, sel: selKey });
}

// ---------------------------------------------------------------- rows
function taskCell(f) {
  if (!f.task) return '<span class="meta zero">нет задачи</span>';
  const t = D.board && tasksView.model().byId.get(f.task);
  return `<span class="meta">${t ? dot(statusTone(t._st), t._st?.title) + ' ' : ''}<span class="mono">${esc(f.task)}</span></span>`;
}
function findingRow(f, sel) {
  const n = new Set((f.files ?? []).map((l) => loc(l).path)).size;
  const html = `${dot(SEV_TONE[sev(f)] || 'muted', 'важность: ' + SEV_RU[sev(f)])}<span class="slot kd">${label(kindRu(f.kind))}</span><span class="ttl">${esc(f.title)}</span>`
    + `<span class="meta">${n} ${plural(n, 'файл', 'файла', 'файлов')}</span><span class="slot tk">${taskCell(f)}</span>`;
  return row({ href: findHref(f.id), key: f.id, sel: sel === f.id, html, cls: f.open ? '' : 'muted', title: f.id });
}
const stat = (n, text, tone = '', to = '') => `${to ? `<a class="stat ${n ? tone : ''}" href="${esc(to)}">` : `<div class="stat ${n ? tone : ''}">`}<b>${typeof n === 'number' ? num(n) : n}</b><span>${esc(text)}</span>${to ? '</a>' : '</div>'}`;
const cnt = (n) => (n ? num(n) : '<span class="zero">0</span>');

// ---------------------------------------------------------------- content views
function overview() {
  const { c, open } = model();
  const s = c.summary;
  const head = `<div class="stats">${stat(s.files, 'файлов', '', '/code/files')}${stat(s.lines, 'строк')}${stat(s.red, 'красных', 'red', '/code/files')}${stat(s.minor, 'жёлтых', 'amber')}${stat(s.ok, 'зелёных', 'green')}${stat(s.stale, 'не проверено')}${stat(s.openFindings, 'открытых находок', 'red', '/code/debt')}${stat(s.dups, 'копий', '', '/code/dups')}${stat(s.orphans, 'никто не импортирует')}${stat(s.lastAudit ? day(s.lastAudit) : '—', 'последний аудит', '', '/code/audits')}</div>`;
  const per = (list) => SEV.map((x) => list.filter((f) => sev(f) === x).length);
  const pil = c.pillars.length ? `<div class="thead">Основы</div><table class="grid"><thead><tr><th>Основа</th><th>Статус</th><th class="n">Высокие</th><th class="n">Средние</th><th class="n">Низкие</th><th>Последний аудит</th></tr></thead><tbody>${c.pillars.map((p) => {
    const fs = open.filter((f) => f.pillar === p.id);
    const [h, m, l] = per(fs);
    return `<tr class="rowlink"><td class="w"><a class="cell" href="/code/pillars/${esc(p.id)}">${dot(PIL_TONE[p.verdict?.status] ?? 'muted')}${esc(p.title)}</a></td><td>${p.verdict ? label(PIL_RU[p.verdict.status] ?? p.verdict.status, PIL_TONE[p.verdict.status]) : '<span class="zero">нет вердикта</span>'}</td><td class="n">${cnt(h)}</td><td class="n">${cnt(m)}</td><td class="n">${cnt(l)}</td><td>${p.verdict ? `<a href="${esc(href('/code/audits', { sel: p.verdict.audit }))}">${esc(p.verdict.audit)}</a> · ${esc(day(p.verdict.ts))}` : ''}</td></tr>`;
  }).join('')}</tbody></table>` : '';
  const areas = c.areas?.length ? `<div class="thead">Области кода</div><table class="grid"><thead><tr><th>Область</th><th class="n">Файлов</th><th class="n">Строк</th><th class="n">Красных</th><th class="n">Жёлтых</th><th class="n">Зелёных</th><th class="n">Находок</th></tr></thead><tbody>${c.areas.map((a) => {
    const fs = Object.values(c.files).filter((f) => f.area === a.id);
    const nf = new Set(fs.flatMap((f) => [...(X.findingsOf.get(f.path) ?? [])])).size;
    return `<tr><td class="w" title="${esc(a.paths.join(', '))}">${esc(a.title)}</td><td class="n">${cnt(fs.length)}</td><td class="n">${cnt(fs.reduce((x, f) => x + f.lines, 0))}</td><td class="n">${cnt(fs.filter((f) => f.status === 'red').length)}</td><td class="n">${cnt(fs.filter((f) => f.status === 'minor').length)}</td><td class="n">${cnt(fs.filter((f) => f.status === 'ok').length)}</td><td class="n">${cnt(nf)}</td></tr>`;
  }).join('')}</tbody></table>` : '';
  const rules = c.patterns?.length ? `<div class="thead">Правила проекта</div><table class="grid"><thead><tr><th>Правило</th><th>Что проверяет</th><th class="n">Мест</th><th class="n">Нарушений</th></tr></thead><tbody>${c.patterns.map((p) => `<tr><td class="mono">${esc(p.id)}</td><td class="w" title="${esc(p.message)}">${esc(p.message)}</td><td class="n">${cnt(p.hits.length)}</td><td class="n">${p.violations.length ? `<span style="color:var(--red)">${p.violations.length}</span>` : cnt(0)}</td></tr>`).join('')}</tbody></table>` : '';
  return { head, body: pil + areas + rules || empty('Аудитов и основ ещё нет: их записывает <code>tasks audit add</code>.') };
}

function pillarsView(sel) {
  const { c, open } = model();
  const head = `<div class="bar">${navBtn}<h1>Основы</h1><span class="meta">${c.pillars.length}</span></div>`;
  const body = c.pillars.map((p) => {
    const n = open.filter((f) => f.pillar === p.id).length;
    return row({ href: '/code/pillars/' + p.id, key: 'pl:' + p.id, html: `${dot(PIL_TONE[p.verdict?.status] ?? 'muted')}<span class="ttl">${esc(p.title)}</span>${p.verdict ? label(PIL_RU[p.verdict.status], PIL_TONE[p.verdict.status]) : ''}<span class="meta">${n} ${plural(n, 'находка', 'находки', 'находок')}</span>` });
  }).join('');
  return { head, body };
}

function pillarView(id, sel) {
  const { open } = model();
  const p = X.pillar.get(id);
  if (!p) return { head: '', body: empty('Нет такой основы.') };
  const fs = open.filter((f) => f.pillar === id);
  const head = `<div class="bar">${navBtn}<div class="crumbs"><a href="/code/pillars">Основы</a><span class="sepr">›</span><b>${esc(p.title)}</b></div>${p.verdict ? label(PIL_RU[p.verdict.status], PIL_TONE[p.verdict.status]) : ''}<span class="meta">${fs.length} ${plural(fs.length, 'открытая находка', 'открытые находки', 'открытых находок')}</span></div>`;
  const body = `<div class="read" style="padding-bottom:8px">${clamp(`<div class="md">${md(p.text)}</div>`, 4)}${p.verdict ? `<div class="para" style="margin-top:8px"><b>Вердикт ${esc(p.verdict.audit)}</b> (${esc(day(p.verdict.ts))}): ${esc(p.verdict.notes ?? '')}</div>` : ''}</div>`
    + (fs.length ? SEV.map((s) => { const l = fs.filter((f) => sev(f) === s); return l.length ? `<div class="grp">${dot(SEV_TONE[s] || 'muted')}<span>${SEV_RU[s]}</span><span class="sub2 meta">${l.length}</span></div>${l.map((f) => findingRow(f, sel)).join('')}` : ''; }).join('') : empty('Открытых находок по этой основе нет.'));
  return { head, body };
}

function debtView(r, sevSel, kindSel, sel) {
  const { c } = model();
  const closed = r.q.get('closed') === '1';
  const q = (r.q.get('q') ?? '').trim().toLowerCase();
  const kinds = listParam('kind'), notask = r.q.get('task');
  const base = c.findings.filter((f) => (closed || f.open) && (!sevSel || sev(f) === sevSel) && (!kindSel || f.kind === kindSel));
  const list = base.filter((f) => (!kinds.length || kinds.includes(f.kind)) && (!notask || (notask === 'none' ? !f.task : !!f.task)) && (!q || `${f.id} ${f.title} ${f.text} ${(f.files ?? []).join(' ')}`.toLowerCase().includes(q)));
  const byKind = new Map();
  for (const f of base) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  const noTask = base.filter((f) => !f.task).length;
  const title = kindSel ? `${SEV_RU[sevSel]} · ${kindRu(kindSel)}` : sevSel ? `Долг: ${SEV_RU[sevSel]}` : 'Долг';
  const open = c.findings.filter((f) => f.open);
  const kpi = (n, text, tone, to) => `<a class="kpi ${n ? tone : ''}" href="${esc(to)}"><b>${n}</b>${esc(text)}</a>`;
  const head = `<div class="bar">${navBtn}<h1>${esc(title)}</h1><span class="cnt">${list.length === base.length ? list.length : `${list.length} из ${base.length}`}</span>`
    + `<span class="kpis">${SEV.map((x) => kpi(open.filter((f) => sev(f) === x).length, SEV_RU[x], SEV_TONE[x], '/code/debt/' + x)).join('')}${kpi(open.filter((f) => f.task).length, 'с задачей', '', withParams({ task: 'some', sel: null }))}${kpi(open.filter((f) => !f.task).length, 'без задачи', '', withParams({ task: 'none', sel: null }))}${kpi(c.findings.length - open.length, 'закрыто', 'green', withParams({ closed: 1, sel: null }))}</span></div>`
    + `<div class="tools"><input type="search" id="dq" placeholder="Поиск: заголовок, текст, файл" value="${esc(r.q.get('q') ?? '')}" autocomplete="off">`
    + (!kindSel && byKind.size > 1 ? `<span class="tsep" title="Вид"></span>${[...byKind].sort((a, b) => b[1] - a[1]).map(([k, n]) => chip('kind', k, kindRu(k), n, kinds.includes(k))).join('')}` : '')
    + `<span class="tsep"></span><a class="chip${notask === 'none' ? ' on' : ''}" href="${esc(withParams({ task: notask === 'none' ? null : 'none', sel: null }))}">нет задачи<span>${noTask}</span></a><a class="chip${closed ? ' on' : ''}" href="${esc(withParams({ closed: closed ? null : 1, sel: null }))}">закрытые</a></div>`;
  if (!list.length) return { head, body: empty(base.length ? 'Под фильтр ничего не попало.' : 'Открытых находок нет.') };
  const body = SEV.map((s) => {
    const l = list.filter((f) => sev(f) === s).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    return l.length ? `<div class="grp">${dot(SEV_TONE[s] || 'muted')}<span>${SEV_RU[s]}</span><span class="sub2 meta">${l.length}</span></div>${l.map((f) => findingRow(f, sel)).join('')}` : '';
  }).join('');
  return { head, body };
}

function folderView(path, sel) {
  const d = dirAt(path);
  if (!d) return { head: '', body: empty(`Папки <code>${esc(path)}</code> нет среди сканируемых.`) };
  const crumbs = path.split('/').filter(Boolean);
  const head = `<div class="bar">${navBtn}<div class="crumbs"><a href="/code/files">Файлы</a>${crumbs.map((p, i) => `<span class="sepr">/</span>${i === crumbs.length - 1 ? `<b>${esc(p)}</b>` : `<a href="/code/files/${esc(crumbs.slice(0, i + 1).join('/'))}/">${esc(p)}</a>`}`).join('')}</div><span class="meta">${d.count} ${plural(d.count, 'файл', 'файла', 'файлов')} · ${num(d.lines)} строк · красных ${d.red}</span></div>`;
  const dirs = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = d.files.slice().sort((a, b) => RANK[b.status] - RANK[a.status] || a.path.localeCompare(b.path));
  const rowsHtml = dirs.map((x) => `<tr class="rowlink" data-key="d:${esc(x.path)}"><td class="w"><a class="cell" href="/code/files/${esc(x.path)}">${dot(FILE_TONE[x.worst])}<b>${esc(x.name)}/</b><span class="meta" style="margin-left:8px">${x.count} ${plural(x.count, 'файл', 'файла', 'файлов')}${x.red ? ` · <span style="color:var(--red)">${x.red} красн.</span>` : ''}</span></a></td><td>${esc(FILE_RU[x.worst])}</td><td class="n">${num(x.lines)}</td><td class="n"></td><td></td></tr>`).join('')
    + files.map((f) => `<tr class="rowlink${sel === f.path ? ' sel' : ''}" data-key="f:${esc(f.path)}"><td class="w"><a class="cell" data-row href="${esc(withParams({ sel: f.path }))}" data-open="${esc(fileHref(f.path))}">${dot(FILE_TONE[f.status])}${esc(f.path.split('/').pop())}${f.orphan ? ' <span class="lbl" style="margin-left:6px">никто не импортирует</span>' : ''}</a></td><td>${esc(FILE_RU[f.status])}</td><td class="n">${num(f.lines)}</td><td class="n">${cnt(X.findingsOf.get(f.path)?.size ?? 0)}</td><td class="n" title="${esc(f.commit ?? '')}">${f.dirty ? 'изменён сейчас' : esc(ago(f.date))}</td></tr>`).join('');
  const body = `<table class="grid"><thead><tr><th>Имя</th><th>Статус</th><th class="n">Строк</th><th class="n">Находок</th><th class="n">Изменён</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
  return { head, body };
}

function sourceView(path, srcDoc, r) {
  const f = D.code.files[path];
  const crumbs = path.split('/');
  const head = `<div class="bar">${navBtn}<div class="crumbs"><a href="/code/files">Файлы</a>${crumbs.map((p, i) => `<span class="sepr">/</span>${i === crumbs.length - 1 ? `<b>${esc(p)}</b>` : `<a href="/code/files/${esc(crumbs.slice(0, i + 1).join('/'))}/">${esc(p)}</a>`}`).join('')}</div>${label(FILE_RU[f.status], FILE_TONE[f.status] === 'muted' ? '' : FILE_TONE[f.status])}<span class="meta">${num(f.lines)} строк · ${f.dirty ? 'изменён сейчас' : `изменён ${esc(ago(f.date))}`}</span></div>`;
  if (!srcDoc) return { head, body: empty('Загрузка исходника…') };
  // what to mark: findings with line ranges, copies, rule hits
  const marks = new Map();
  const mark = (from, to, cls, why) => { for (let i = from; i <= (to ?? from); i++) { const m = marks.get(i) ?? { cls: new Set(), why: [] }; m.cls.add(cls); m.why.push(why); marks.set(i, m); } };
  for (const fd of X.findingsOf.get(path) ?? []) for (const l of fd.files) { const x = loc(l); if (x.path === path && x.from) mark(x.from, x.to, sev(fd) === 'low' ? 'f low' : 'f', `${fd.id}: ${fd.title}`); }
  for (const d of f.dups) mark(d.at[0], d.at[1], 'd', `копия ${d.lines} строк: ${d.with}:${d.there[0]}-${d.there[1]}`);
  for (const p of f.patterns) mark(p.line, p.line, 'f', `правило ${p.id}: ${p.message}`);
  const at = r.q.get('line') ? loc(':' + r.q.get('line')) : null;
  const lines = srcDoc.text.split('\n');
  const body = `<table class="src"><tbody>${lines.map((l, i) => {
    const n = i + 1, m = marks.get(n);
    const isAt = at && n >= at.from && n <= at.to;
    return `<tr id="L${n}" class="${m ? [...m.cls].join(' ') : ''}${isAt ? ' at' : ''}"><td class="n"${m ? ` title="${esc(m.why.join('\n'))}"` : ''}>${n}</td><td class="c">${esc(l) || ' '}</td></tr>`;
  }).join('')}</tbody></table>`;
  return { head, body };
}

function dupsView(sel) {
  const { c } = model();
  const red = c.summary.dupRed;
  const head = `<div class="bar">${navBtn}<h1>Копии</h1><span class="meta">${c.dups.length} · от ${red} строк — красные</span></div>`;
  if (!c.dups.length) return { head, body: empty('Одинаковых кусков кода сканер не нашёл.') };
  const body = c.dups.map((d) => row({ href: withParams({ sel: 'dup:' + d.id }), key: 'dup:' + d.id, sel: sel === 'dup:' + d.id, html: `<span class="slot ln">${label(`${d.lines} строк`, d.lines >= red ? 'red' : '')}</span><span class="ttl mono" style="font-size:12px">${esc(d.a.file)}:${d.a.from}-${d.a.to}</span><span class="meta">↔</span><span class="ttl mono" style="font-size:12px">${esc(d.b.file)}:${d.b.from}-${d.b.to}</span>` })).join('');
  return { head, body };
}

function auditsView(sel) {
  const { c } = model();
  const head = `<div class="bar">${navBtn}<h1>Аудиты</h1><span class="meta">${c.audits.length}</span></div>`;
  if (!c.audits.length) return { head, body: empty('Аудитов ещё нет: их записывает <code>tasks audit add</code> по вердикту независимого аудитора.') };
  const body = c.audits.slice().reverse().map((a) => {
    const tv = Object.entries(a.tasks ?? {});
    return row({ href: withParams({ sel: a.id }), key: a.id, sel: sel === a.id, html: `<span class="id">${esc(a.id)}</span><span class="ttl">${esc(a.title)}</span>${tv.map(([id, v]) => label(`${id} ${v.verdict}`, v.verdict === 'pass' ? 'green' : 'red')).join('')}<span class="meta">${a.files} ${plural(a.files, 'файл', 'файла', 'файлов')} · ${a.findings} ${plural(a.findings, 'находка', 'находки', 'находок')}</span><span class="meta up">${esc(day(a.ts))}</span>` });
  }).join('');
  return { head, body };
}

// ---------------------------------------------------------------- contexts
const closeBtn = `<span class="acts"><button class="ibtn" data-act="close" title="Закрыть (Esc)">${ICON_X}</button></span>`;
const fileLink = (l) => { const x = loc(l); const f = D.code.files[x.path]; if (!f) return `<div class="li missing" title="Файла нет среди сканируемых: удалён или переименован">${dot('hollow')}<span class="ttl mono">${esc(l)}</span><span class="meta">нет в коде</span></div>`; return `<a href="${esc(fileHref(x.path, { line: x.from ? `${x.from}-${x.to}` : null }))}" title="${esc(l)}">${dot(FILE_TONE[f?.status] ?? 'muted')}<span class="ttl mono">${esc(x.path)}${x.from ? `<span style="color:var(--muted)">:${x.from}${x.to !== x.from ? '-' + x.to : ''}</span>` : ''}</span></a>`; };
const mdo = () => ({ ids: D.board ? tasksView.model().ids : null, code: (c) => { const x = loc(c); return D.code.files[x.path] ? fileHref(x.path, { line: x.from ? `${x.from}-${x.to}` : null }) : null; } });

// the guardians' marks on a file, from their sweeps of the whole project (references/guardians.md)
const guardianName = (id) => D.code.guardians?.list.find((g) => g.id === id)?.name ?? id;
const GUARD_MARK = { home: ['владелец', ''], clean: ['✓', 'green'], broken: ['✗', 'red'] };
function guardianRow(f) {
  const gs = D.code.guardians?.list ?? [];
  if (!gs.length) return null;
  return gs.map((g) => {
    const m = f.guards?.[g.id];
    if (!m?.audit && !m?.mark) return `<span class="zero">«${esc(g.name)}» не читал</span>`;
    const [txt, tone] = GUARD_MARK[m.mark] ?? [m.mark, ''];
    const tip = [m.audit && `${m.audit} ${day(m.ts)}`, m.notes, m.stale && 'файл изменён после обхода'].filter(Boolean).join(' · ');
    return `<span title="${esc(tip)}">«${esc(g.name)}» ${label(m.mark === 'broken' && m.findings ? `${txt} ${m.findings.length}` : txt, m.stale ? 'amber' : tone)}</span>`;
  }).join('<br>');
}

function findingCtx(f) {
  const t = f.task && D.board ? tasksView.model().byId.get(f.task) : null;
  const pil = f.pillar && X.pillar.get(f.pillar);
  const head = `<div class="ch"><div class="top">${label(SEV_RU[sev(f)], SEV_TONE[sev(f)])}${label(kindRu(f.kind))}<span class="id">${esc(f.id)}</span>${f.open ? '' : label('закрыта', 'green')}${closeBtn}</div><h2>${esc(f.title)}</h2>`
    + props([
      ['Задача', f.task ? `<a href="${esc(href('/tasks', { sel: f.task }))}">${t ? dot(statusTone(t._st)) + ' ' : ''}${esc(f.task)}</a>${t ? ` · ${esc(t._st?.title ?? t.status)}` : ''}` : '<span class="zero">нет задачи — заводится через <code>tasks audit task</code></span>'],
      ['Аудит', `<a href="${esc(href('/code/audits', { sel: f.audit }))}">${esc(f.audit)}</a> · ${esc(day(f.ts))}`],
      ['Основа', pil ? `<a href="/code/pillars/${esc(pil.id)}">${esc(pil.title)}</a>` : f.pillar ?? null],
      ['Хранитель', f.guardian ? `«${esc(guardianName(f.guardian))}»${f.rule ? ` · правило <span class="mono">${esc(f.rule)}</span>` : ''}` : null],
      ['Закрыта', f.resolvedBy ? esc(f.resolvedBy) : null],
    ]) + '</div>';
  const body = section('f:text', 'Находка', `<div class="md small">${md(f.text, mdo())}</div>`, { open: true })
    + section('f:fix', 'Что делать', f.fix && `<div class="md small">${md(f.fix, mdo())}</div>`, { open: true })
    + section('f:files', 'Файлы', `<div class="list">${(f.files ?? []).map(fileLink).join('')}</div>`, { count: (f.files ?? []).length, open: true });
  return { key: 'f:' + f.id, head, body };
}

function fileCtx(f) {
  const v = f.audit;
  const head = `<div class="ch"><div class="top">${dot(FILE_TONE[f.status])}<span>${esc(FILE_RU[f.status])}</span>${f.entry ? label('точка входа') : ''}${f.orphan ? label('никто не импортирует', 'amber') : ''}${closeBtn}</div><h2 class="mono" style="font-size:13px">${esc(f.path)}</h2>`
    + props([
      ['Область', (D.code.areas ?? []).find((a) => a.id === f.area)?.title ?? f.area ?? null],
      ['Строк', num(f.lines)],
      ['Изменён', f.dirty ? 'сейчас (не в коммите)' : f.date ? `${esc(ago(f.date))} · <span class="mono">${esc(f.commit ?? '')}</span>` : null],
      ['Хранители', guardianRow(f)],
      ['Аудит', v ? `${label(v.status, VERDICT_TONE[v.status])} <a href="${esc(href('/code/audits', { sel: v.audit }))}">${esc(v.audit)}</a>${f.changedSinceAudit ? ' · <span style="color:var(--amber)">изменён после аудита</span>' : ''}` : '<span class="zero">не проверялся</span>'],
      ['Исходник', `<a href="${esc(fileHref(f.path))}">открыть</a>`],
    ]) + '</div>';
  const reasons = f.reasons.map((x) => {
    const to = /^A-\d+#\d+$/.test(x.ref) ? href('/code/debt', { sel: x.ref }) : /^A-\d+$/.test(x.ref) ? href('/code/audits', { sel: x.ref }) : /^dup#/.test(x.ref) ? href('/code/dups', { sel: 'dup:' + x.ref.slice(4) }) : null;
    return `<div class="li" style="align-items:flex-start;padding:2px 0">${label(kindRu(x.kind), x.severity ? SEV_TONE[x.severity] : 'red')}<span class="para" style="flex:1">${to ? `<a href="${esc(to)}">${esc(x.text)}</a>` : esc(x.text)}${x.task ? ` · <a href="${esc(href('/tasks', { sel: x.task }))}">${esc(x.task)}</a>` : ''}</span></div>`;
  }).join('');
  const verdicts = f.verdicts.slice().reverse().map((x) => `<div class="li" style="align-items:flex-start;padding:2px 0">${label(x.status, VERDICT_TONE[x.status])}<span class="para" style="flex:1"><a href="${esc(href('/code/audits', { sel: x.audit }))}">${esc(x.audit)}</a> ${esc(day(x.ts))}${x.notes ? ': ' + esc(x.notes) : ''}</span></div>`).join('');
  const list = (ps) => `<div class="list">${ps.map((p) => fileLink(p)).join('')}</div>`;
  const body = section('file:reasons', 'Причины статуса', reasons && `<div class="list">${reasons}</div>`, { count: f.reasons.length })
    + section('file:verdicts', 'Вердикты аудитов', verdicts && `<div class="list">${verdicts}</div>`, { count: f.verdicts.length })
    + section('file:dups', 'Копии', f.dups.length && `<div class="list">${f.dups.map((d) => `<a href="${esc(withParams({ sel: 'dup:' + d.id }))}">${label(`${d.lines} строк`, d.lines >= D.code.summary.dupRed ? 'red' : '')}<span class="ttl mono">${esc(d.with)}:${d.there[0]}-${d.there[1]}</span></a>`).join('')}</div>`, { count: f.dups.length })
    + section('file:imports', 'Импортирует', f.imports.length && list(f.imports), { count: f.imports.length, open: false })
    + section('file:importers', 'Импортируют его', f.importers.length && list(f.importers), { count: f.importers.length, open: false });
  return { key: 'file:' + f.path, head, body };
}

function auditCtx(a) {
  const full = D.code.findings.filter((f) => f.audit === a.id);
  const head = `<div class="ch"><div class="top"><span class="id">${esc(a.id)}</span><span>${esc(day(a.ts))}</span>${closeBtn}</div><h2>${esc(a.title)}</h2>`
    + props([['Аудитор', esc(a.auditor ?? '—')], ['Файлов', a.files], ['Находок', `${a.findings}${full.length ? ` · открыто ${full.filter((f) => f.open).length}` : ''}`], ['Закрывает', a.resolves?.length ? a.resolves.map((id) => `<a href="${esc(href('/code/debt', { sel: id, closed: 1 }))}">${esc(id)}</a>`).join(', ') : null]]) + '</div>';
  const tv = Object.entries(a.tasks ?? {});
  const pv = D.code.pillars.map((p) => [p, p.history.find((h) => h.audit === a.id)]).filter(([, h]) => h);
  const body = section('a:summary', 'Итог', `<div class="md small">${clamp(md(a.summary, mdo()), 6)}</div>`, { open: true })
    + section('a:tasks', 'Задачи', tv.length && `<div class="list">${tv.map(([id, v]) => `<a href="${esc(href('/tasks', { sel: id }))}">${label(v.verdict, v.verdict === 'pass' ? 'green' : 'red')}<span class="ttl">${esc(id)}</span></a>`).join('')}</div>`, { count: tv.length })
    + section('a:pillars', 'Основы', pv.length && `<div class="list">${pv.map(([p, h]) => `<a href="/code/pillars/${esc(p.id)}" title="${esc(h.notes ?? '')}">${dot(PIL_TONE[h.status] ?? 'muted')}<span class="ttl">${esc(p.title)}</span><span class="meta">${esc(PIL_RU[h.status] ?? h.status)}</span></a>`).join('')}</div>`, { count: pv.length })
    + section('a:findings', 'Находки', full.length && `<div class="list">${full.map((f) => `<a href="${esc(href('/code/debt', { sel: f.id, closed: f.open ? null : 1 }))}" title="${esc(f.id)}">${label(SEV_RU[sev(f)][0], SEV_TONE[sev(f)])}<span class="ttl${f.open ? '' : ' zero'}">${esc(f.title)}</span></a>`).join('')}</div>`, { count: full.length });
  return { key: 'a:' + a.id, head, body };
}

function dupCtx(d) {
  const head = `<div class="ch"><div class="top">${label(`${d.lines} строк`, d.lines >= D.code.summary.dupRed ? 'red' : '')}<span>копия #${d.id}</span>${closeBtn}</div><h2>Одинаковый код в двух местах</h2></div>`;
  const body = `<div class="summ"><div class="list">${fileLink(`${d.a.file}:${d.a.from}-${d.a.to}`)}${fileLink(`${d.b.file}:${d.b.from}-${d.b.to}`)}</div><div class="para">Сканер сравнивает значимые строки (без пустых, скобок и импортов). Красной копия считается от ${D.code.summary.dupRed} строк.</div></div>`;
  return { key: 'dup:' + d.id, head, body };
}

function ctxFor(sel) {
  if (!sel) return null;
  if (/^A-\d+#\d+$/.test(sel)) { const f = X.byId.get(sel); return f ? findingCtx(f) : null; }
  if (/^A-\d+$/.test(sel)) { const a = X.audit.get(sel); return a ? auditCtx(a) : null; }
  if (sel.startsWith('dup:')) { const d = D.code.dups.find((x) => x.id === +sel.slice(4)); return d ? dupCtx(d) : null; }
  const f = D.code.files[sel];
  return f ? fileCtx(f) : null;
}

// ---------------------------------------------------------------- the view
export default {
  id: 'code',
  async load(r) {
    await need('code');
    if (!D.board) need('board').then(() => window.dispatchEvent(new Event('tt:repaint'))).catch(() => {});
    const [v, ...rest] = (r.rest ?? '').split('/');
    const p = rest.join('/');
    if (v === 'files' && D.code.files[p]) srcCache.set(p, await doc('/api/code/file?path=' + encodeURIComponent(p)).catch(() => null));
  },
  render(r) {
    model();
    const [v = '', ...rest] = (r.rest ?? '').split('/');
    const sub = rest.join('/');
    const sel = r.sel;
    let out, key, title;
    if (v === 'pillars' && sub) { out = pillarView(sub, sel); key = 'pl:' + sub; title = X.pillar.get(sub)?.title; }
    else if (v === 'pillars') { out = pillarsView(sel); key = 'pillars'; title = 'Основы'; }
    else if (v === 'debt') { const [s, k] = rest; out = debtView(r, s, k, sel); key = k ? `debt:${s}:${k}` : s ? 'debt:' + s : 'debt'; title = 'Долг'; }
    else if (v === 'files' && D.code.files[sub]) { out = sourceView(sub, srcCache.get(sub), r); key = 'f:' + sub; title = sub.split('/').pop(); }
    else if (v === 'files') { out = folderView(sub, sel); key = sub ? 'd:' + sub.replace(/\/?$/, '/') : 'files'; title = 'Файлы'; }
    else if (v === 'dups') { out = dupsView(sel); key = 'dups'; title = 'Копии'; }
    else if (v === 'audits') { out = auditsView(sel); key = 'audits'; title = 'Аудиты'; }
    else { out = overview(); key = 'overview'; title = 'Код'; }
    const ctx = ctxFor(sel);
    return {
      nav: navHtml(r, key), navSearch: 'Поиск: раздел, основа, файл', tree: 'code', view: r.rest || 'overview',
      head: out.head, body: `<div class="rows">${out.body}</div>`, title,
      ctx: ctx ?? (sel ? { key: 'none', head: '', body: empty(`«${esc(sel)}» не найдено.`) } : null),
    };
  },
  after(r, out, { sameView }) {
    const line = r.q.get('line');
    if (line && (!sameView || lastLine !== location.search)) document.getElementById('L' + line.split('-')[0])?.scrollIntoView({ block: 'center' });
    lastLine = location.search;
    const q = document.getElementById('dq');
    if (q && !q.dataset.bound) {
      q.dataset.bound = '1';
      let timer;
      q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => window.dispatchEvent(new CustomEvent('tt:go', { detail: { to: withParams({ q: q.value, sel: null }), replace: true } })), 150); });
    }
  },
  changed(kind, old) {
    if (kind !== 'code' || !old) return [];
    srcCache.clear();
    return Object.values(D.code.files).filter((f) => old.files[f.path]?.status !== f.status || old.files[f.path]?.hash !== f.hash).map((f) => 'f:' + f.path);
  },
};
let lastLine = null;
// source texts read synchronously at render: load() awaits them first
const srcCache = new Map();
