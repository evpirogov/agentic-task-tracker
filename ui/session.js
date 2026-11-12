// A Claude Code session, opened from a task: the rail and the tasks' navigation stay, the
// transcript is the content, the task it was opened from stays in the context.
import { $, esc, md, clamp, empty, stamp, href, withParams, label, plural } from './lib.js';
import { D, need, doc } from './data.js';
import tasksView from './tasks.js';

const ROLE = { user: 'Пользователь', agent: 'Агент', summary: 'Сжатие контекста' };
const navIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>';
const cache = new Map();
let scrolledFor = null;

export default {
  id: 'session',
  async load(r) {
    await need('board');
    if (!cache.has(r.id)) cache.set(r.id, await doc('/api/session?id=' + encodeURIComponent(r.id)).catch((e) => ({ error: e.message })));
  },
  render(r) {
    const s = cache.get(r.id);
    const m = tasksView.model();
    const t = r.sel ? m.byId.get(r.sel) : null;
    const out = { nav: tasksView.navHtml({ ...r, q: new URLSearchParams() }), navSearch: 'Фильтр: статусы, теги', tree: 'tasks', view: 'session:' + r.id, title: `Сессия ${r.id.slice(0, 8)}` };
    const back = t ? `<a href="${esc(href('/tasks', { sel: t.id }))}">${esc(t.id)}</a><span class="sepr">›</span>` : '';
    if (!s || s.error) {
      out.head = `<div class="bar"><div class="crumbs"><a href="/tasks">Задачи</a><span class="sepr">›</span>${back}<b>Сессия ${esc(r.id.slice(0, 8))}</b></div></div>`;
      out.body = empty(`Расшифровки этой сессии нет в ~/.claude/projects (${esc(s?.error ?? '')}).`);
    } else {
      const onlyUser = r.q.get('user') === '1', tools = r.q.get('tools') === '1';
      const msgs = s.messages.filter((x) => (!onlyUser || x.role === 'user') && (x.text || tools));
      const at = r.q.get('at');
      let near = -1;
      if (at) { let best = Infinity; msgs.forEach((x, i) => { if (x.ts) { const d = Math.abs(Date.parse(x.ts) - Date.parse(at)); if (d < best) { best = d; near = i; } } }); }
      const touched = [...new Set(D.board.events.filter((e) => e.session === r.id).map((e) => e.task))];
      const ts = s.messages.filter((x) => x.ts);
      const users = s.messages.filter((x) => x.role === 'user').length;
      out.head = `<div class="bar"><button class="ibtn navbtn" data-act="nav" title="Навигация">${navIcon}</button><div class="crumbs"><a href="/tasks">Задачи</a><span class="sepr">›</span>${back}<b>Сессия <span class="mono">${esc(r.id.slice(0, 8))}</span></b></div><span class="meta">${ts.length ? `${esc(stamp(ts[0].ts))} – ${esc(stamp(ts.at(-1).ts))} · ` : ''}${(s.size / 1048576).toFixed(1)} МБ</span></div>`
        + `<div class="stats"><div class="stat"><b>${s.messages.length}</b><span>записей</span></div><div class="stat"><b>${users}</b><span>сообщений пользователя</span></div><div class="stat"><b>${touched.length}</b><span>${plural(touched.length, 'задача', 'задачи', 'задач')} в журнале</span></div></div>`
        + `<div class="tools"><a class="chip${onlyUser ? ' on' : ''}" href="${esc(withParams({ user: onlyUser ? null : 1 }))}">только пользователь</a><a class="chip${tools ? ' on' : ''}" href="${esc(withParams({ tools: tools ? null : 1 }))}">инструменты</a>`
        + (touched.length ? `<span class="tsep"></span>${[...new Set([r.sel, ...touched].filter((x) => x && touched.includes(x)))].slice(0, 6).map((id) => `<a class="chip${id === r.sel ? ' on' : ''}" href="${esc(withParams({ sel: id }))}" title="${esc(m.byId.get(id)?.title ?? '')}">${esc(id)}</a>`).join('')}${touched.length > 6 ? `<span class="tl">ещё ${touched.length - 6}</span>` : ''}` : '') + '</div>';
      const opts = { ids: m.ids };
      out.body = msgs.length ? msgs.map((x, i) => {
        const body = x.role === 'summary' ? clamp(`<div class="md small">${md(x.text, opts)}</div>`, 2) : x.role === 'agent' && i !== near ? clamp(`<div class="md">${md(x.text, opts)}</div>`, 8) : `<div class="md">${md(x.text, opts)}</div>`;
        const tl = tools && x.tools?.length ? `<div class="tchips">${x.tools.map((tt) => `<span class="tool" title="${esc(tt.gist)}">${esc(tt.name)}${tt.gist ? ': ' + esc(tt.gist) : ''}</span>`).join('')}</div>` : '';
        return `<div class="msg ${x.role}${i === near ? ' at' : ''}" id="m${i}"><div class="who"><b>${ROLE[x.role]}</b>${x.ts ? esc(stamp(x.ts)) : ''}</div><div class="body">${x.text ? body : ''}${tl}</div></div>`;
      }).join('') : empty('Нет сообщений под этот фильтр.');
      out.near = near;
    }
    if (t) out.ctx = { key: 'task:' + t.id, head: tasksView.taskHead(t, false), body: tasksView.taskBody(t, false) };
    return out;
  },
  after(r, out) {
    const key = location.pathname + (r.q.get('at') ?? '');
    if (out.near >= 0 && scrolledFor !== key) document.getElementById('m' + out.near)?.scrollIntoView({ block: 'center' });
    scrolledFor = key;
  },
};
