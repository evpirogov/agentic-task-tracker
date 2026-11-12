// Wiki: a staircase tree (sections of the home page → pages → headings of the open page) →
// the page (breadcrumbs, a 760 px text column) → the page's links (what points here, what it
// points to, code and tasks it names).
import { $, $$, esc, md, dot, tree, treeHead, props, section, empty, ago, day, href, withParams, openSet, slug, api, store } from './lib.js';
import { D, need, doc } from './data.js';
import tasksView, { statusTone, ICON_X } from './tasks.js';

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
function norm(p) {
  const out = [];
  for (const s of p.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return out.join('/');
}
const docUrl = (p) => '/api/wiki/doc?path=' + encodeURIComponent(p);
const plain = (s) => String(s).replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_~]/g, '');
const navIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>';

// ---------------------------------------------------------------- structure from the home page
let S = null, Sfor = null;
async function structure() {
  const w = D.wiki;
  const home = await doc(docUrl(w.home));
  if (S && Sfor === w && S.homeText === home.text) return S;
  const byPath = new Map(w.pages.map((p) => [p.path, p]));
  const sections = [];
  let cur = null, fence = false;
  const listed = new Set([w.home]);
  for (const line of home.text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const h = /^##\s+(.+?)\s*#*$/.exec(line);
    if (h) { cur = { key: 's:' + slug(h[1]), title: plain(h[1]), intro: '', pages: [] }; sections.push(cur); continue; }
    if (!cur) continue;
    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    const links = [...line.matchAll(/\[([^\]]+)\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)];
    if (li && links.length) {
      const [, lab, to] = links[0];
      const path = norm(dirOf(w.home) + to);
      if (byPath.has(path)) {
        const desc = li[1].slice(li[1].indexOf(links[0][0]) + links[0][0].length).replace(/^\s*[—–:-]\s*/, '');
        cur.pages.push({ path, label: plain(lab), desc });
        listed.add(path);
      }
    } else if (line.trim() && !/^#/.test(line)) cur.intro += (cur.intro ? '\n' : '') + line;
  }
  const rest = w.pages.filter((p) => !listed.has(p.path));
  if (rest.length) sections.push({ key: 's:~other', title: 'Другие страницы', intro: 'Страницы, на которые нет ссылки с главной.', pages: rest.map((p) => ({ path: p.path, label: p.title, desc: '' })) });
  S = { homeText: home.text, sections, byPath };
  Sfor = w;
  return S;
}
const pageLabel = (path) => {
  for (const s of S.sections) for (const p of s.pages) if (p.path === path) return p.label;
  return S.byPath.get(path)?.title ?? path;
};
const sectionOf = (path) => S.sections.find((s) => s.pages.some((p) => p.path === path));

// ---------------------------------------------------------------- links in a page
function codeHref(c) {
  const m = /^(.+?)(?::(\d+)(?:-\d+)?)?$/.exec(c.trim());
  const p = m?.[1];
  if (p && D.code?.files?.[p]) return href('/code/files/' + p, { sel: p, line: m[2] });
  return null;
}
function linkFor(from, to) {
  if (/^(https?:|mailto:)/.test(to)) return to;
  if (to.startsWith('#')) return '/wiki/' + from + to;
  const [p, anchor] = to.split('#');
  const inWiki = norm(dirOf(from) + p);
  if (S.byPath.has(inWiki)) return '/wiki/' + inWiki + (anchor ? '#' + anchor : '');
  const fromRoot = norm(D.wiki.dir + '/' + dirOf(from) + p);
  if (D.code?.files?.[fromRoot]) return href('/code/files/' + fromRoot, { sel: fromRoot });
  const task = /\.tasks\/items\/([A-Za-z]+-\d+)\.md$/.exec(fromRoot);
  if (task) return href('/tasks', { sel: task[1] });
  return '/api/wiki/asset?path=' + encodeURIComponent(inWiki);
}
const taskIds = () => (D.board ? tasksView.model().ids : null);
const mdOpts = (path, extra = {}) => ({ link: (h) => linkFor(path, h), code: codeHref, ids: taskIds(), asset: (src) => (/^https?:/.test(src) ? src : '/api/wiki/asset?path=' + encodeURIComponent(norm(dirOf(path) + src))), ...extra });

// ---------------------------------------------------------------- search (full text on the server)
const hits = new Map();
function textHits(q) {
  if (hits.has(q)) return hits.get(q);
  hits.set(q, null);
  api('/api/wiki/search?q=' + encodeURIComponent(q)).then((r) => { hits.set(q, r); window.dispatchEvent(new Event('tt:repaint')); }).catch(() => hits.delete(q));
  return null;
}

// ---------------------------------------------------------------- the view
let rendered = { path: null, heads: [], html: '' };
let lastHash = null;
export default {
  id: 'wiki',
  async load(r) {
    await need('wiki');
    await structure();
    if (!D.board) need('board').then(() => window.dispatchEvent(new Event('tt:repaint'))).catch(() => {});
    if (D.project.code && !D.code) need('code').then(() => window.dispatchEvent(new Event('tt:repaint'))).catch(() => {});
    const path = r.rest || D.wiki.home;
    if (!r.q.get('section') && S.byPath.has(path)) docCache.set(path, await doc(docUrl(path)));
  },
  render(r) {
    const w = D.wiki;
    const secKey = r.q.get('section');
    const path = secKey ? null : r.rest || w.home;
    const q = (r.q.get('q') ?? '').trim();
    const out = { tree: 'wikiclosed', navSearch: 'Поиск по вики', bodyClass: '' };
    const navBtn = `<button class="ibtn navbtn" data-act="nav" title="Навигация">${navIcon}</button>`;

    // the page text first: its headings feed the tree
    let heads = [];
    const pageDoc = path ? docCache.get(path) : null;
    if (pageDoc) {
      heads = [];
      const html = md(pageDoc.text, mdOpts(path, { heads, mark: q ? q.toLowerCase().split(/\s+/).filter((x) => x.length > 1) : null }));
      rendered = { path, heads, html };
    }

    // nav: the staircase
    const f = r.navq.trim().toLowerCase();
    const headNodes = (path && rendered.path === path) ? nest(rendered.heads.filter((h) => h.level >= 2 && h.level <= 3), path) : [];
    let nodes = [{ key: 'p:' + w.home, label: 'Главная', href: '/wiki', title: w.dir + '/' + w.home, children: null }];
    for (const s of S.sections) {
      nodes.push({
        key: s.key, label: s.title, href: href('/wiki', { section: s.key }), meta: s.pages.length,
        children: s.pages.map((p) => ({ key: 'p:' + p.path, label: p.label, href: '/wiki/' + p.path, title: `${w.dir}/${p.path}`, children: p.path === path ? headNodes : null })),
      });
    }
    const closedSet = openSet('wikiclosed');
    const open = new Set();
    const walk = (ns) => { for (const n of ns) if (n.children?.length) { if (!closedSet.has(n.key)) open.add(n.key); walk(n.children); } };
    walk(nodes);
    // the open page's section and the page itself are always open
    const curSec = path && sectionOf(path);
    if (curSec) open.add(curSec.key);
    if (path) open.add('p:' + path);
    if (f) {
      const keep = (ns) => ns.map((n) => {
        const kids = n.children ? keep(n.children) : [];
        return n.label.toLowerCase().includes(f) || kids.length ? { ...n, children: kids.length ? kids : n.children, forceOpen: kids.length > 0 } : null;
      }).filter(Boolean);
      nodes = keep(nodes);
    }
    let nav = tree(nodes, { open, sel: secKey ?? 'p:' + path });
    if (f.length > 1) {
      const res = textHits(f);
      nav += treeHead('В тексте', res ? String(res.length) : '…');
      nav += res == null ? '' : res.length ? res.map((h) => `<a class="row t hit" style="--lvl:0" href="${esc(href('/wiki/' + h.path, { q: f }))}" title="${esc(h.hits.map((x) => x.text).join('\n'))}"><i class="caret none"></i><span class="lab">${esc(pageLabel(h.path))}</span><span class="meta">${h.count}</span></a>`).join('') : '<div class="empty">Нет совпадений</div>';
    } else if (f && !nodes.length) nav += '<div class="empty">Ничего не найдено</div>';
    out.nav = nav;

    // a section: its pages as rows
    if (secKey) {
      const s = S.sections.find((x) => x.key === secKey);
      out.view = 'section:' + secKey;
      out.title = s?.title ?? 'Вики';
      if (!s) { out.head = ''; out.body = empty('Нет такого раздела.'); return out; }
      out.head = `<div class="bar">${navBtn}<div class="crumbs"><a href="/wiki">Вики</a><span class="sepr">›</span><b>${esc(s.title)}</b></div><span class="meta">${s.pages.length} стр.</span></div>`;
      out.body = (s.intro ? `<div class="read" style="padding-bottom:6px"><div class="md">${md(s.intro, mdOpts(w.home))}</div></div>` : '')
        + `<div class="rows">${s.pages.map((p) => { const pg = S.byPath.get(p.path); return `<a class="row" href="/wiki/${esc(p.path)}" data-key="p:${esc(p.path)}" title="${esc(w.dir + '/' + p.path)}"><span class="ttl" style="flex:0 1 auto">${esc(p.label)}</span><span class="sub">${esc(plain(p.desc))}</span><span class="meta">${esc(ago(pg?.mtime))}</span></a>`; }).join('')}</div>`;
      return out;
    }

    // a page
    out.view = 'page:' + path;
    const pg = S.byPath.get(path);
    if (!pg || !pageDoc) {
      out.title = 'Вики';
      out.head = `<div class="bar">${navBtn}<div class="crumbs"><a href="/wiki">Вики</a></div></div>`;
      out.body = empty(`Страницы <code>${esc(path)}</code> нет в ${esc(w.dir)}/.`);
      return out;
    }
    out.title = pageLabel(path);
    const sTitle = curSec ? `<a href="${esc(href('/wiki', { section: curSec.key }))}">${esc(curSec.title)}</a><span class="sepr">›</span>` : '';
    out.head = `<div class="bar">${navBtn}<div class="crumbs">${path === w.home ? '' : `<a href="/wiki">Вики</a><span class="sepr">›</span>`}${sTitle}<b>${esc(path === w.home ? 'Главная' : pageLabel(path))}</b></div><span class="meta" title="${esc(w.dir + '/' + path)}">изменена ${esc(ago(pg.mtime))}</span><button class="ibtn ctxbtn" data-act="ctx" title="Связи страницы (])"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M9.5 2.5v11"/></svg></button></div>`;
    out.body = `<div class="read"><div class="md" id="wikidoc">${rendered.html}</div></div>`;
    out.ctx = { key: 'wiki:' + path, passive: true, ...pageCtx(path, pg, pageDoc.text) };
    return out;
  },
  after(r, out, { sameView }) {
    const mainb = $('#mainb');
    const hash = decodeURIComponent(location.hash.slice(1));
    const key = location.pathname + '#' + hash;
    if (hash && (key !== lastHash || !sameView)) document.getElementById(hash)?.scrollIntoView({ block: 'start' });
    else if (!sameView && !hash) { const m = $('#wikidoc mark'); if (m) m.scrollIntoView({ block: 'center' }); }
    lastHash = key;
    if (!mainb.dataset.spy) {
      mainb.dataset.spy = '1';
      mainb.addEventListener('scroll', () => { if (location.pathname.startsWith('/wiki')) spy(); }, { passive: true });
    }
    spy();
  },
  changed(kind, old) {
    if (kind !== 'wiki' || !old) return [];
    const was = new Map(old.pages.map((p) => [p.path, p.mtime]));
    docCache.clear();
    return D.wiki.pages.filter((p) => was.get(p.path) !== p.mtime).map((p) => 'p:' + p.path);
  },
};

// the page texts by path, filled when load() awaited them (render is synchronous)
const docCache = new Map();

// ## headings with their ### below them
function nest(heads, path) {
  const out = [];
  let h2 = null;
  for (const h of heads) {
    const n = { key: 'h:' + h.id, label: plain(h.text), href: `/wiki/${path}#${h.id}`, cls: 'h', children: [] };
    if (h.level === 2 || !h2) { out.push(n); h2 = n; } else h2.children.push(n);
  }
  for (const n of out) if (!n.children.length) n.children = null;
  return out;
}

// the heading the reader is in, marked in the tree
function spy() {
  const mainb = $('#mainb');
  const hs = $$('#wikidoc h2, #wikidoc h3');
  let cur = null;
  const top = mainb.getBoundingClientRect().top;
  for (const h of hs) { if (h.getBoundingClientRect().top - top <= 40) cur = h.id; else break; }
  for (const el of $$('#navb .row.cur')) el.classList.remove('cur');
  if (cur) { const el = document.querySelector(`#navb [data-key="h:${CSS.escape(cur)}"]`); el?.classList.add('cur'); }
}

// the context: what this page is tied to
function pageCtx(path, pg, text) {
  const w = D.wiki;
  const back = w.pages.filter((p) => p.links?.includes(path));
  const outl = (pg.links ?? []).filter((p) => S.byPath.has(p));
  const codes = [];
  if (D.code) {
    const seen = new Set();
    for (const m of text.matchAll(/`([^`\s]+?)(?::\d+(?:-\d+)?)?`|\]\(([^)\s]+)\)/g)) {
      let p = m[1] ?? (m[2] && norm(w.dir + '/' + dirOf(path) + m[2].split('#')[0]));
      if (p && D.code.files[p] && !seen.has(p)) { seen.add(p); codes.push(D.code.files[p]); }
    }
  }
  const taskRows = [];
  if (D.board) {
    const m = tasksView.model();
    const named = new Set(text.match(m.ids) ?? []);
    const full = `${w.dir}/${path}`;
    for (const t of m.tasks) if (named.has(t.id) || Object.values(t.sections ?? {}).some((s) => s.includes(full)) || t.docs?.includes(full)) taskRows.push(t);
  }
  const pageLink = (p) => `<a href="/wiki/${esc(p)}"><span class="ttl">${esc(pageLabel(p))}</span></a>`;
  const CODE_TONE = { red: 'red', minor: 'amber', stale: 'muted', ok: 'green' };
  const lines = text.split('\n').length;
  const head = `<div class="ch"><div class="top"><span>Страница</span><span class="acts"><button class="ibtn" data-act="ctx" title="Скрыть панель (])">${ICON_X}</button></span></div><h2>${esc(path === w.home ? 'Главная' : pageLabel(path))}</h2>`
    + props([['Файл', `<code>${esc(w.dir + '/' + path)}</code>`], ['Изменена', `${esc(ago(pg.mtime))} · ${esc(day(pg.mtime))}`], ['Объём', `${lines} строк`], ['Раздел', sectionOf(path)?.title ?? (path === w.home ? '—' : null)]]) + '</div>';
  const body = section('wiki:back', 'Ссылаются сюда', back.length && `<div class="list">${back.map((p) => pageLink(p.path)).join('')}</div>`, { count: back.length })
    + section('wiki:out', 'Ссылки отсюда', outl.length && `<div class="list">${outl.map(pageLink).join('')}</div>`, { count: outl.length })
    + section('wiki:code', 'Код на странице', codes.length && `<div class="list">${codes.map((f) => `<a href="${esc(href('/code/files/' + f.path, { sel: f.path }))}" title="${esc(f.path)}">${dot(CODE_TONE[f.status] ?? 'muted')}<span class="ttl mono">${esc(f.path)}</span></a>`).join('')}</div>`, { count: codes.length })
    + section('wiki:tasks', 'Задачи', taskRows.length && `<div class="list">${taskRows.map((t) => `<a href="${esc(href('/tasks', { sel: t.id }))}" title="${esc(t.title)}">${dot(statusTone(t._st))}<span class="mono" style="color:var(--muted)">${esc(t.id)}</span><span class="ttl">${esc(t.title)}</span></a>`).join('')}</div>`, { count: taskRows.length })
    || empty('Связей с другими страницами, кодом и задачами нет.');
  return { head, body };
}
