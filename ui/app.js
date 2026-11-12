// The shell: rail, the four zones, routing, the one selection model, keys, live updates.
// A view (tasks.js, wiki.js, code.js, session.js) renders HTML for the zones from the route;
// project pages (the lab, the game) fill everything right of the rail in an iframe.
import { $, $$, esc, store, ICONS, withParams, toggleOpen } from './lib.js';
import { D, need, reload, dropDocs } from './data.js';
import tasks from './tasks.js';
import wiki from './wiki.js';
import code from './code.js';
import session from './session.js';

const VIEWS = { tasks, wiki, code, session };
const S = { navq: {}, last: {}, view: '', ctxKey: '', ctxOff: store.get('ctxOff', false), navOff: store.get('navOff', false), navOpen: false, flash: new Set(), reveal: true, frames: new Map(), live: false };
queueMicrotask(() => applyTheme()); // the kept theme before the first paint
const app = $('#app');
const narrow = matchMedia('(max-width: 900px)');
const mid = matchMedia('(max-width: 1100px)');

// ---------------------------------------------------------------- routing
function route() {
  const segs = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(location.search);
  const sel = q.get('sel');
  if (segs[0] === 'p') return { sec: 'page', id: segs[1] ?? '', q, sel };
  if (segs[0] === 'session') return { sec: 'session', id: segs[1] ?? '', q, sel };
  return { sec: segs[0] || 'tasks', rest: segs.slice(1).join('/'), q, sel };
}

export function go(to, { replace = false, reveal = false } = {}) {
  if (to === location.pathname + location.search + location.hash) return paint();
  history[replace ? 'replaceState' : 'pushState'](null, '', to);
  S.reveal = reveal;
  paint();
}

// ---------------------------------------------------------------- theme
// auto (the system's) → light → dark, kept per browser; the project's pages in frames get it in
// their address (?theme=) and by a message when it changes
const THEMES = { auto: 'Тема: как в системе', light: 'Тема: светлая', dark: 'Тема: тёмная' };
const THEME_ICON = {
  auto: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11A5.5 5.5 0 0 0 8 2.5z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></svg>',
  dark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z"/></svg>',
};
const themeOf = () => (THEMES[store.get('theme', 'auto')] ? store.get('theme', 'auto') : 'auto');
function applyTheme() {
  const t = themeOf();
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  for (const f of S.frames.values()) f.contentWindow?.postMessage({ theme: t }, '*');
}
function nextTheme() {
  const order = Object.keys(THEMES);
  store.set('theme', order[(order.indexOf(themeOf()) + 1) % order.length]);
  applyTheme();
  rail(route());
}

// ---------------------------------------------------------------- rail
function initials(name) {
  const w = String(name).split(/[\s_\-.]+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : String(name).slice(0, 2)).toUpperCase();
}
function rail(r) {
  const p = D.project;
  const items = [['tasks', '/tasks', 'Задачи', ICONS.tasks]];
  if (p.wiki) items.push(['wiki', '/wiki', 'Вики', ICONS.wiki]);
  if (p.code) items.push(['code', '/code', 'Код', ICONS.code]);
  for (const pg of p.pages ?? []) {
    const icon = ICONS[pg.icon] ?? ICONS[pg.id] ?? ICONS.page;
    const shortName = pg.short ?? (pg.title.length <= 8 ? pg.title : pg.title.slice(0, 3));
    items.push(['p:' + pg.id, `/p/${encodeURIComponent(pg.id)}`, shortName, icon, pg.title]);
  }
  const cur = r.sec === 'page' ? 'p:' + r.id : r.sec === 'session' ? 'tasks' : r.sec;
  const wait = tasks.waitingCount?.() ?? 0;
  $('#rail').innerHTML = `<a class="proj" href="/tasks" title="${esc(p.name)}\n${esc(p.root)}">${esc(initials(p.name))}</a>`
    + items.map(([id, h, t, icon, full]) => `<a class="ri${id === cur ? ' on' : ''}" href="${esc(id === cur ? h : S.last[id] ?? h)}" data-rail="${esc(id)}" title="${esc(full ?? t)}">${icon}<span>${esc(t)}</span>${id === 'tasks' && wait ? `<b class="badge" title="Ждёт меня: ${wait}">${wait}</b>` : ''}</a>`).join('')
    + `<span class="grow"></span><button class="ri theme" data-act="theme" title="${esc(THEMES[themeOf()])} — сменить">${THEME_ICON[themeOf()]}<span>Тема</span></button><span class="live${S.live ? ' on' : ''}" title="${S.live ? 'Живые обновления: файлы проекта отслеживаются' : 'Нет связи с сервером — переподключение…'}"></span>`;
}

// ---------------------------------------------------------------- painting
const scrollOf = (el) => (el ? el.scrollTop : 0);
async function paint() {
  const r = route();
  if (location.pathname === '/' && /^#[A-Za-z]+-\d+$/.test(location.hash)) return go(`/tasks?sel=${location.hash.slice(1)}`, { replace: true });
  await need('project');
  if (r.sec !== 'page' && r.sec !== 'session' && !VIEWS[r.sec]) return go('/tasks', { replace: true });
  if ((r.sec === 'wiki' && !D.project.wiki) || (r.sec === 'code' && !D.project.code)) return go('/tasks', { replace: true });
  if (r.sec === 'page') return paintPage(r);
  const view = VIEWS[r.sec];
  try {
    await view.load(r);
  } catch (e) {
    showError(e);
    return;
  }
  const fixed = view.normalize?.(r);
  if (fixed) return go(fixed, { replace: true });
  S.last[r.sec === 'session' ? 'tasks' : r.sec] = location.pathname + location.search;
  r.navq = S.navq[r.sec] ?? '';
  const out = view.render(r);
  document.title = `${out.title ? out.title + ' · ' : ''}${D.project.name}`;
  rail(r);
  app.classList.remove('framed', 'pageview');
  clearTimeout(pageTimer);
  for (const f of S.frames.values()) f.hidden = true;

  const navb = $('#navb'), mainb = $('#mainb'), ctxb = $('#ctxb');
  const sameView = S.view === r.sec + '|' + out.view;
  const sameCtx = S.ctxKey === (out.ctx?.key ?? '');
  if (!sameCtx) S.peek = false;
  const keep = { nav: scrollOf(navb), main: scrollOf(mainb), ctx: scrollOf(ctxb), navSec: navb.dataset.sec };
  const focus = document.activeElement;
  const focusId = focus?.id, caret = focus?.selectionStart;

  // nav
  const nq = $('#navq');
  nq.placeholder = out.navSearch ?? 'Поиск';
  if (nq.dataset.sec !== r.sec) { nq.value = S.navq[r.sec] ?? ''; nq.dataset.sec = r.sec; }
  navb.innerHTML = out.nav ?? '';
  navb.dataset.sec = r.sec;
  navb.dataset.tree = out.tree ?? r.sec;
  // main
  $('#mainh').innerHTML = out.head ?? '';
  mainb.innerHTML = out.body ?? '';
  mainb.className = 'main-body ' + (out.bodyClass ?? '');
  // context
  const hasCtx = !!out.ctx;
  $('#ctxh').innerHTML = hasCtx ? out.ctx.head ?? '' : '';
  ctxb.innerHTML = hasCtx ? out.ctx.body ?? '' : '';
  S.passive = hasCtx && !!out.ctx.passive;
  app.classList.toggle('has-ctx', hasCtx && !S.ctxOff && !(S.passive && mid.matches && !S.peek));
  app.classList.toggle('ctx-closable', hasCtx);
  app.classList.toggle('nav-off', S.navOff);
  // a task open on the board: the nav steps aside while it is open, so every column stays in view
  app.classList.toggle('nav-aside', out.bodyClass === 'boardwrap' && app.classList.contains('has-ctx') && !narrow.matches);

  if (keep.navSec === r.sec) navb.scrollTop = keep.nav;
  if (sameView) mainb.scrollTop = keep.main;
  if (sameView && sameCtx) ctxb.scrollTop = keep.ctx;
  S.view = r.sec + '|' + out.view;
  S.ctxKey = out.ctx?.key ?? '';
  if (focusId && document.getElementById(focusId) && focus !== document.getElementById(focusId)) {
    const el = document.getElementById(focusId);
    el.focus();
    try { el.setSelectionRange(caret, caret); } catch {}
  }
  bindClamps(document);
  view.after?.(r, out, { sameView, reveal: S.reveal });
  if (S.reveal) {
    for (const el of [navb.querySelector('.row.sel'), mainb.querySelector('.row.sel, tr.sel')]) el?.scrollIntoView({ block: 'nearest' });
    S.reveal = false;
  }
  if (S.flash.size) {
    for (const el of $$('[data-key]')) if (S.flash.has(el.dataset.key)) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    S.flash.clear();
  }
}

function showError(e) {
  rail(route());
  $('#mainh').innerHTML = '';
  $('#mainb').innerHTML = `<div class="empty">Не удалось загрузить данные: ${esc(e.message)}</div>`;
}

// «развернуть» only where the text is really longer than the fold
function bindClamps(root) {
  for (const c of $$('.clamp', root)) {
    const btn = c.nextElementSibling;
    if (!btn?.classList.contains('more')) continue;
    btn.hidden = !(c.classList.contains('open') || c.scrollHeight > c.clientHeight + 2);
    btn.textContent = c.classList.contains('open') ? 'свернуть' : 'развернуть';
  }
}

// ---------------------------------------------------------------- project pages (iframe)
async function reachable(url) {
  try { await fetch(url, { mode: 'no-cors', cache: 'no-store' }); return true; } catch { return false; }
}
// a page on this machine (localhost in project.json) is opened at the host the admin was
// opened at: from another machine on the network that is this one's address, not its own
const LOCAL = ['localhost', '127.0.0.1', '[::1]'];
const pageUrl = (pg) => {
  const u = new URL(pg.url);
  if (LOCAL.includes(u.hostname) && !LOCAL.includes(location.hostname)) u.hostname = location.hostname;
  return u.toString();
};
const embedUrl = (pg) => {
  if (pg.embed === false) return pageUrl(pg);
  const u = new URL(pageUrl(pg));
  u.searchParams.set('embed', '1');
  if (themeOf() !== 'auto') u.searchParams.set('theme', themeOf());
  return u.toString();
};
let pageTimer = null;
async function paintPage(r) {
  clearTimeout(pageTimer);
  const pg = (D.project.pages ?? []).find((x) => x.id === r.id);
  rail(r);
  S.last['p:' + r.id] = location.pathname;
  document.title = `${pg?.title ?? r.id} · ${D.project.name}`;
  app.classList.remove('has-ctx', 'ctx-closable');
  app.classList.add('pageview');
  S.view = '';
  for (const [id, f] of S.frames) f.hidden = id !== r.id;
  if (!pg) { app.classList.remove('framed'); $('#navb').innerHTML = ''; $('#mainh').innerHTML = ''; $('#mainb').innerHTML = `<div class="empty">Страницы «${esc(r.id)}» нет в .tasks/project.json (pages).</div>`; return; }
  const up = await reachable(pageUrl(pg));
  if (route().sec !== 'page' || route().id !== r.id) return;
  if (up) {
    app.classList.add('framed');
    if (!S.frames.has(r.id)) {
      const f = document.createElement('iframe');
      f.src = embedUrl(pg);
      f.title = pg.title;
      f.allow = 'fullscreen; clipboard-read; clipboard-write; gamepad; autoplay';
      $('#frames').append(f);
      S.frames.set(r.id, f);
    }
    S.frames.get(r.id).hidden = false;
  } else {
    app.classList.remove('framed');
    S.frames.get(r.id)?.remove();
    S.frames.delete(r.id);
    $('#navb').innerHTML = '';
    $('#mainh').innerHTML = '';
    $('#mainb').innerHTML = `<div class="empty">${esc(pg.title)} не отвечает на <a href="${esc(pageUrl(pg))}" target="_blank" rel="noopener">${esc(pageUrl(pg))}</a>${pg.start ? ` — её запускает <code>${esc(pg.start)}</code> в корне проекта` : ''}. Проверяю каждые 3 с.</div>`;
  }
  // keep watching: the dev server may stop or come up
  pageTimer = setTimeout(() => { if (route().sec === 'page' && route().id === r.id) paintPage(r); }, up ? 10000 : 3000);
}

// ---------------------------------------------------------------- panels: resize, collapse
function setW(pane, w) {
  const [min, max] = pane === 'nav' ? [200, 420] : [300, 640];
  w = Math.max(min, Math.min(max, Math.round(w)));
  app.style.setProperty(pane === 'nav' ? '--nav' : '--ctx', w + 'px');
  return w;
}
setW('nav', store.get('w:nav', 260));
setW('ctx', store.get('w:ctx', 380));
for (const sp of $$('.split')) {
  sp.addEventListener('pointerdown', (e) => {
    const pane = sp.dataset.pane;
    const box = $('#' + pane).getBoundingClientRect();
    sp.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    let w = box.width;
    const move = (ev) => { w = setW(pane, pane === 'nav' ? ev.clientX - box.left : box.right - ev.clientX); };
    const up = () => { sp.removeEventListener('pointermove', move); document.body.classList.remove('resizing'); store.set('w:' + pane, w); };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up, { once: true });
  });
  sp.addEventListener('dblclick', () => { store.set('w:' + sp.dataset.pane, null); setW(sp.dataset.pane, sp.dataset.pane === 'nav' ? 260 : 380); });
}
function toggleNav(force) {
  if (narrow.matches) { S.navOpen = force ?? !S.navOpen; app.classList.toggle('nav-open', S.navOpen); return; }
  S.navOff = force != null ? !force : !S.navOff;
  store.set('navOff', S.navOff);
  app.classList.toggle('nav-off', S.navOff);
}
function toggleCtx(force) {
  // below 1100 px a context that is not a selection (the wiki page's links) opens only on demand
  if (mid.matches && S.passive) {
    S.peek = force != null ? force : !app.classList.contains('has-ctx');
    app.classList.toggle('has-ctx', S.peek);
    return;
  }
  S.ctxOff = force != null ? !force : !S.ctxOff;
  if (!mid.matches) store.set('ctxOff', S.ctxOff);
  app.classList.toggle('has-ctx', app.classList.contains('ctx-closable') && !S.ctxOff);
}
// below 1100 px the context slides over the content: it opens with a selection, not by itself
mid.addEventListener('change', () => { S.ctxOff = mid.matches ? false : store.get('ctxOff', false); paint(); });
narrow.addEventListener('change', () => { S.navOpen = false; app.classList.remove('nav-open'); });

// ---------------------------------------------------------------- clicks
document.addEventListener('click', (e) => {
  const tog = e.target.closest('[data-toggle]');
  if (tog && (tog.classList.contains('caret') || !tog.closest('a'))) {
    e.preventDefault();
    const nb = $('#navb');
    if (tog.dataset.toggle && !tog.classList.contains('none')) { toggleOpen(nb.dataset.tree, tog.dataset.toggle); paint(); }
    return;
  }
  const sec = e.target.closest('.sec-h');
  if (sec) {
    const s = sec.parentElement;
    s.classList.toggle('open');
    store.set('sec:' + s.dataset.sec, s.classList.contains('open'));
    bindClamps(s);
    return;
  }
  const more = e.target.closest('.more');
  if (more) {
    const c = more.previousElementSibling;
    c.classList.toggle('open');
    bindClamps(c.parentElement);
    return;
  }
  const fold = e.target.closest('[data-fold]');
  if (fold && fold.dataset.fold) {
    store.set('fold:' + fold.dataset.fold, !store.get('fold:' + fold.dataset.fold, true));
    paint();
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act) {
    e.preventDefault();
    if (act.dataset.act === 'close') closeSel();
    if (act.dataset.act === 'nav') toggleNav();
    if (act.dataset.act === 'ctx') toggleCtx();
    if (act.dataset.act === 'theme') nextTheme();
    return;
  }
  const a = e.target.closest('a[href]');
  if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.preventDefault();
  if (a.dataset.rail && a.classList.contains('on') && narrow.matches) { toggleNav(); return; }
  if (narrow.matches && a.closest('#nav') && !a.classList.contains('parent')) toggleNav(false);
  if (a.closest('.ctx-zone') || a.closest('#nav')) S.reveal = true;
  // a selection opened from the list opens the context even after it was hidden
  if (u.searchParams.get('sel') && S.ctxOff) { S.ctxOff = false; store.set('ctxOff', false); }
  go(u.pathname + u.search + u.hash, { reveal: !a.closest('#main') });
});
document.addEventListener('dblclick', (e) => {
  const r = e.target.closest('[data-open]');
  if (r) go(r.dataset.open, { reveal: true });
});
window.addEventListener('tt:repaint', () => { if (route().sec !== 'page') paint(); });
window.addEventListener('tt:go', (e) => go(e.detail.to, { replace: e.detail.replace }));
window.addEventListener('popstate', () => { S.reveal = true; paint(); });

function closeSel() {
  const q = new URLSearchParams(location.search);
  if (q.has('sel') || q.has('full')) go(withParams({ sel: null, full: null, line: null }));
  else toggleCtx(false);
}

// ---------------------------------------------------------------- keys
$('#navq').addEventListener('input', (e) => {
  S.navq[route().sec] = e.target.value;
  paint();
});
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t.matches?.('input, textarea, select');
  if (e.key === 'Escape') {
    if (typing) { if (t.value) { t.value = ''; t.dispatchEvent(new Event('input')); } else t.blur(); return; }
    if (narrow.matches && S.navOpen) return toggleNav(false);
    if (app.classList.contains('has-ctx') || new URLSearchParams(location.search).has('sel')) return closeSel();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (typing) {
    if (e.key === 'ArrowDown' && t.id === 'navq') { e.preventDefault(); move('nav', 1); t.blur(); }
    if (e.key === 'Enter' && t.id === 'navq') { e.preventDefault(); const first = $('#navb .row[href]'); if (first) first.click(); t.blur(); }
    return;
  }
  if (e.key === '/') { e.preventDefault(); if (narrow.matches) toggleNav(true); else if (S.navOff) toggleNav(true); $('#navq').focus(); $('#navq').select(); return; }
  if (e.key === '[') return toggleNav();
  if (e.key === ']') return toggleCtx();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    move(zone(), e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1);
    return;
  }
  if (e.key === 'Enter') {
    const z = zone();
    const cur = $(`#${z === 'nav' ? 'navb' : 'mainb'} :is(.row.sel, tr.sel a[data-row])`);
    if (!cur) return;
    e.preventDefault();
    if (cur.dataset.open) go(cur.dataset.open, { reveal: true });
    else if (cur.classList.contains('parent')) { toggleOpen($('#navb').dataset.tree, cur.dataset.key); paint(); }
  }
});
// which list the arrows move in: the one last clicked; the content's list by default
let lastZone = 'main';
document.addEventListener('pointerdown', (e) => { if (e.target.closest('#nav')) lastZone = 'nav'; else if (e.target.closest('#main')) lastZone = 'main'; }, true);
const zone = () => (lastZone === 'main' && $('#mainb :is(.row[href], a[data-row])') ? 'main' : 'nav');
const isSel = (el) => el.classList.contains('sel') || !!el.closest('tr.sel');
function move(z, d) {
  const rows = $$(`#${z === 'nav' ? 'navb' : 'mainb'} :is(.row[href], a[data-row])`).filter((r) => r.offsetParent);
  if (!rows.length) return;
  let i = rows.findIndex(isSel);
  i = i < 0 ? (d > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + d));
  const to = new URL(rows[i].href, location.href);
  lastZone = z;
  S.reveal = true;
  go(to.pathname + to.search + to.hash, { replace: true, reveal: true });
}

// ---------------------------------------------------------------- live
const KIND = { change: ['board'], wiki: ['wiki'], code: ['code'] };
function live() {
  const es = new EventSource('/api/stream');
  let lost = false;
  const setLive = (on) => { S.live = on; const l = $('#rail .live'); if (l) { l.classList.toggle('on', on); l.title = on ? 'Живые обновления: файлы проекта отслеживаются' : 'Нет связи с сервером — переподключение…'; } };
  es.onopen = () => { setLive(true); if (lost) for (const k of Object.keys(KIND)) refresh(k); lost = false; };
  es.onerror = () => { setLive(false); lost = true; };
  for (const k of Object.keys(KIND)) es.addEventListener(k, () => refresh(k));
}
async function refresh(kind) {
  if (kind === 'wiki') dropDocs('/api/wiki/');
  if (kind === 'code') dropDocs('/api/code/');
  if (kind === 'change') await reload('project').catch(() => {});
  for (const k of KIND[kind]) {
    const old = await reload(k).catch(() => null);
    if (!old) continue;
    for (const v of Object.values(VIEWS)) for (const key of v.changed?.(k, old) ?? []) S.flash.add(key);
  }
  if (route().sec !== 'page') paint();
}

need('project').then(() => { paint(); live(); }).catch(showError);
