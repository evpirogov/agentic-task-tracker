// The data the views read, loaded once and refreshed on server events. Read-only: the admin
// never writes; everything here is a GET.
import { api } from './lib.js';

export const D = { project: null, board: null, wiki: null, code: null };
const URLS = { project: '/api/project', board: '/api/board', wiki: '/api/wiki', code: '/api/code' };
const pending = {};

export function need(k) {
  if (D[k]) return Promise.resolve(D[k]);
  return (pending[k] ??= api(URLS[k]).then(
    (v) => { D[k] = v; delete pending[k]; return v; },
    (e) => { delete pending[k]; throw e; },
  ));
}

// fetch afresh; returns the previous value so a view can tell what changed
export async function reload(k) {
  const old = D[k];
  if (!old && !pending[k]) return null; // never loaded: nothing to refresh
  D[k] = await api(URLS[k]);
  return old;
}

// smaller things fetched on demand: wiki pages, source files, session transcripts
const docs = new Map();
export function doc(url) {
  if (!docs.has(url)) docs.set(url, api(url).catch((e) => { docs.delete(url); throw e; }));
  return docs.get(url);
}
export const peek = async (url) => (docs.has(url) ? docs.get(url).catch(() => null) : null);
export function dropDocs(prefix) { for (const k of [...docs.keys()]) if (k.startsWith(prefix)) docs.delete(k); }
