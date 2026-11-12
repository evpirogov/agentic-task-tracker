// Shared by every view: helpers, markdown, the components of the spec (row, tree, label,
// props, collapsible section, clamp, empty state). Views return HTML strings built from these.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// per-viewer conveniences only (panel widths, open sections, folded groups)
export const store = {
  get(k, d) { try { const v = localStorage.getItem('tt:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tt:' + k, JSON.stringify(v)); } catch {} },
};

export async function api(url) {
  const r = await fetch(url, { cache: 'no-store' });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.error ?? `${url}: ${r.status}`);
  return body;
}

export function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}
export const num = (n) => Number(n).toLocaleString('ru-RU');
export function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 45) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
  return day(ts);
}
export const short = (ts) => ago(ts).replace(' назад', '');
export const day = (ts) => (ts ? new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
export const stamp = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
export const slug = (s) => String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_~[\]()]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'h';

// ---------------------------------------------------------------- url
// The selection lives in the address: a link is the path plus changed query params.
export function href(path, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '' && v !== false) q.set(k, v === true ? '1' : v);
  const s = q.toString();
  return path + (s ? '?' + s : '');
}
// the current address with some params changed (null removes)
export function withParams(params, path = location.pathname) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) { if (v == null || v === '' || v === false) q.delete(k); else q.set(k, v === true ? '1' : v); }
  const s = q.toString();
  return path + (s ? '?' + s : '');
}

// ---------------------------------------------------------------- markdown
// opts.link(href) → href to use; opts.code(text) → href for an inline code span or null;
// opts.ids → RegExp of task ids to link; opts.heads → array to collect headings into;
// opts.mark → words to highlight.
export function inline(s, opts = {}) {
  const codes = [];
  let h = esc(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  const links = [];
  h = h
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${esc(opts.asset ? opts.asset(src.replace(/&amp;/g, '&')) : src)}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, to) => {
      const t = opts.link ? opts.link(to.replace(/&amp;/g, '&')) : to;
      const ext = /^https?:/.test(t);
      links.push(`<a href="${esc(t)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${txt}</a>`);
      return `\u0001${links.length - 1}\u0001`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,:;!?]|$)/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
  if (opts.ids) h = h.replace(opts.ids, (m) => `<a href="/tasks?sel=${m}">${m}</a>`);
  if (opts.mark?.length) {
    const re = new RegExp(`(${opts.mark.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    h = h.split(/(<[^>]+>)/).map((part) => (part.startsWith('<') ? part : part.replace(re, '<mark>$1</mark>'))).join('');
  }
  h = h.replace(/\u0001(\d+)\u0001/g, (_, i) => links[Number(i)]);
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const c = codes[Number(i)];
    const to = opts.code && opts.code(c);
    return to ? `<a href="${esc(to)}"><code>${esc(c)}</code></a>` : `<code>${esc(c)}</code>`;
  });
}

export function md(text, opts = {}) {
  const out = [];
  const lines = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r/g, '').split('\n');
  const used = new Map();
  const idFor = (t) => { const b = slug(t); const n = used.get(b) ?? 0; used.set(b, n + 1); return n ? `${b}-${n}` : b; };
  let i = 0;
  const il = (s) => inline(s, opts);
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }
    if ((m = /^\s*(```|~~~)/.exec(line))) {
      const fence = m[1], buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line))) {
      const lvl = m[1].length, n = Math.min(lvl + (opts.shift ?? 0), 6);
      const id = idFor(m[2]);
      opts.heads?.push({ level: lvl, text: m[2], id });
      out.push(`<h${n} id="${esc(id)}">${il(m[2])}</h${n}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${il(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${il(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${md(buf.join('\n'), { ...opts, heads: null })}</blockquote>`);
      continue;
    }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const lm = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(l);
        if (lm) { items.push({ ind: lm[1].length, ol: !!lm[3], text: lm[4] }); i++; continue; }
        if (l.trim() && /^\s{2,}\S/.test(l) && items.length) { items[items.length - 1].text += '\n' + l.trim(); i++; continue; }
        break;
      }
      const build = (from, ind) => {
        let html = '', k = from;
        const ol = items[from].ol;
        while (k < items.length && items[k].ind >= ind) {
          if (items[k].ind > ind) { const [sub, next] = build(k, items[k].ind); html = html.replace(/<\/li>$/, sub + '</li>'); k = next; continue; }
          const t = items[k].text;
          const cb = /^\[([ xX])\]\s+(.*)$/s.exec(t);
          html += cb
            ? `<li class="task${cb[1] !== ' ' ? ' done' : ''}"><i class="cb"></i>${il(cb[2]).replace(/\n/g, '<br>')}</li>`
            : `<li>${il(t).replace(/\n/g, '<br>')}</li>`;
          k++;
        }
        return [`<${ol ? 'ol' : 'ul'}>${html}</${ol ? 'ol' : 'ul'}>`, k];
      };
      out.push(build(0, items[0].ind)[0]);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|(?:[-*+]|\d+[.)])\s)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) para.push(lines[i++]);
    if (para.length) out.push(`<p>${para.map(il).join('<br>')}</p>`);
    else i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------- components

// a status dot: tone is a token name (red, amber, green, blue, violet, muted, hollow)
export const dot = (tone, title = '') => `<i class="dot ${tone}"${title ? ` title="${esc(title)}"` : ''}></i>`;
// a label: importance, status, size
export const label = (text, tone = '', title = '') => `<span class="lbl ${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
export const empty = (html) => `<div class="empty">${html}</div>`;
export const meta = (html) => `<span class="meta">${html}</span>`;
// a thin progress bar with N/M
export const progress = (done, total, title = '') => (total ? `<span class="prog" title="${esc(title || `${done} из ${total}`)}"><i style="width:${Math.round((100 * done) / total)}%"></i></span><span class="pnum">${done}/${total}</span>` : '');

// a grid of key — value
export const props = (pairs) => `<dl class="props">${pairs.filter((p) => p && p[1] != null && p[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

// a collapsible section; its open state is remembered per key
export function section(key, title, body, { count = '', open = true } = {}) {
  if (!body) return '';
  const isOpen = store.get('sec:' + key, open);
  return `<section class="sec${isOpen ? ' open' : ''}" data-sec="${esc(key)}"><button class="sec-h" type="button"><i class="caret"></i><span>${esc(title)}</span>${count !== '' ? `<span class="cnt">${count}</span>` : ''}</button><div class="sec-b">${body}</div></section>`;
}

// long text folded to `lines` lines with a «развернуть» toggle (shown only when it overflows)
export const clamp = (html, lines = 4, cls = '') => `<div class="clamp ${cls}" style="--lines:${lines}">${html}</div><button class="more" type="button" hidden>развернуть</button>`;

// a list row: everything is a link, the selection is in the address
export function row({ href: to, key, sel, html, cls = '', title = '', open = '' }) {
  return `<a class="row ${cls}${sel ? ' sel' : ''}" href="${esc(to)}" data-key="${esc(key)}"${open ? ` data-open="${esc(open)}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${html}</a>`;
}

// a tree: nodes {key, label, href?, dot?, meta?, title?, muted?, children?}; open = Set of keys
// (the selected node's ancestors are opened by the caller); a node without href toggles.
export function tree(nodes, { open, sel, lvl = 0 } = {}) {
  let out = '';
  for (const n of nodes) {
    const kids = n.children?.length ? n.children : null;
    const isOpen = kids && (n.forceOpen || open?.has(n.key));
    const cls = ['row', 't', n.key === sel ? 'sel' : '', n.muted ? 'muted' : '', n.cls ?? '', kids ? 'parent' : ''].join(' ');
    const inner = `<i class="caret${kids ? (isOpen ? ' down' : '') : ' none'}" data-toggle="${esc(n.key)}"></i>${n.dot ?? ''}<span class="lab">${n.html ?? esc(n.label)}</span>${n.meta != null ? `<span class="meta">${n.meta}</span>` : ''}`;
    const attrs = `class="${cls}" style="--lvl:${lvl}" data-key="${esc(n.key)}"${n.title ? ` title="${esc(n.title)}"` : ''}`;
    out += n.href ? `<a ${attrs} href="${esc(n.href)}">${inner}</a>` : `<div ${attrs} data-toggle="${esc(n.key)}" tabindex="-1">${inner}</div>`;
    if (isOpen) out += tree(kids, { open, sel, lvl: lvl + 1 });
  }
  return out;
}
export const treeHead = (text, meta = '') => `<div class="thead"><span>${esc(text)}</span>${meta ? `<span class="meta">${meta}</span>` : ''}</div>`;

// the open nodes of a tree, remembered per tree
export const openSet = (name) => new Set(store.get('open:' + name, []));
export function toggleOpen(name, key) {
  const s = openSet(name);
  if (s.has(key)) s.delete(key); else s.add(key);
  store.set('open:' + name, [...s]);
}

// a chip of a toolbar filter (multi-select in one URL param)
export function chip(param, value, text, count, active) {
  const cur = new URLSearchParams(location.search).get(param)?.split(',').filter(Boolean) ?? [];
  const next = active ? cur.filter((x) => x !== value) : [...cur, value];
  return `<a class="chip${active ? ' on' : ''}" href="${esc(withParams({ [param]: next.join(','), sel: null }))}">${esc(text)}${count != null ? `<span>${count}</span>` : ''}</a>`;
}
export const params = () => new URLSearchParams(location.search);
export const listParam = (k) => params().get(k)?.split(',').filter(Boolean) ?? [];

// icons for the rail: functional, 18 px, stroke only
const I = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICONS = {
  tasks: I('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M3.5 6l1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17"/>'),
  wiki: I('<path d="M4 4.5h6a2 2 0 0 1 2 2V20a1.5 1.5 0 0 0-1.5-1.5H4z"/><path d="M20 4.5h-6a2 2 0 0 0-2 2V20a1.5 1.5 0 0 1 1.5-1.5H20z"/>'),
  code: I('<path d="M8.5 7L4 12l4.5 5M15.5 7L20 12l-4.5 5M13.5 5l-3 14"/>'),
  lab: I('<path d="M9.5 3.5h5M10 3.5v6L4.8 18.3A1.5 1.5 0 0 0 6.1 20.5h11.8a1.5 1.5 0 0 0 1.3-2.2L14 9.5v-6"/><path d="M7.5 14.5h9"/>'),
  game: I('<path d="M6.5 8.5h11a4 4 0 0 1 4 4.4l-.4 3a2.7 2.7 0 0 1-4.6 1.5L14.6 15.5H9.4l-1.9 1.9a2.7 2.7 0 0 1-4.6-1.5l-.4-3a4 4 0 0 1 4-4.4z"/><path d="M7.5 11v3M6 12.5h3M15.5 12.5h.01M17.5 11.5h.01"/>'),
  page: I('<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 8.5h17"/>'),
};
