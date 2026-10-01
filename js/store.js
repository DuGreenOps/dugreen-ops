// Data layer with one interface and two back-ends:
//  - CloudStore: Supabase (shared team data, logins, file storage, Claude edge function)
//  - DemoStore:  this browser only (localStorage + IndexedDB) for trying the app before the server is set up
import { CONFIG } from './config.js';
import { uid } from './util.js';

const CHILDREN = {
  projects: [['areas', 'project_id'], ['spec_items', 'project_id'], ['rfqs', 'project_id'], ['quotes', 'project_id'], ['selections', 'project_id'], ['purchase_orders', 'project_id'], ['costing', 'project_id'], ['claude_log', 'project_id']],
  areas: [['spec_items', 'area_id']],
  rfqs: [['rfq_lines', 'rfq_id']],
  quotes: [['quote_lines', 'quote_id']],
  purchase_orders: [['po_lines', 'po_id']],
  suppliers: [['library_prices', 'supplier_id']],
};

export function serverConfig() {
  let url = CONFIG.SUPABASE_URL, key = CONFIG.SUPABASE_ANON_KEY;
  if (!url) { try { const s = JSON.parse(localStorage.getItem('dg-server') || 'null'); if (s) { url = s.url; key = s.key; } } catch (e) { } }
  return url && key ? { url, key } : null;
}

// ---------------------------------------------------------------- Cloud
class CloudStore {
  constructor({ url, key }) {
    this.mode = 'cloud';
    this.sb = window.supabase.createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
    this.profile = null;
  }
  async session() { const { data } = await this.sb.auth.getSession(); return data.session; }
  async signIn(email, password) { const { error } = await this.sb.auth.signInWithPassword({ email, password }); if (error) throw error; return this.me(true); }
  async signUp(email, password, full_name) {
    const { data, error } = await this.sb.auth.signUp({ email, password, options: { data: { full_name }, emailRedirectTo: location.origin + location.pathname } });
    if (error) throw error; return data;
  }
  async resetPassword(email) { const { error } = await this.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }); if (error) throw error; }
  async updatePassword(password) { const { error } = await this.sb.auth.updateUser({ password }); if (error) throw error; }
  async signOut() { await this.sb.auth.signOut(); this.profile = null; }
  async me(force) {
    if (this.profile && !force) return this.profile;
    const s = await this.session(); if (!s) return null;
    const { data } = await this.sb.from('profiles').select('*').eq('id', s.user.id).maybeSingle();
    this.profile = data || { id: s.user.id, email: s.user.email, role: 'pending' };
    return this.profile;
  }
  q(table, match = {}) { let q = this.sb.from(table).select('*'); for (const [k, v] of Object.entries(match)) q = v === null ? q.is(k, null) : Array.isArray(v) ? q.in(k, v) : q.eq(k, v); return q; }
  async list(table, match = {}, order = 'created_at') {
    let q = this.q(table, match); if (order) q = q.order(order, { ascending: true });
    const { data, error } = await q.limit(5000); if (error) throw error; return data;
  }
  async get(table, id) { const { data, error } = await this.sb.from(table).select('*').eq('id', id).maybeSingle(); if (error) throw error; return data; }
  async insert(table, rows) {
    const arr = Array.isArray(rows) ? rows : [rows];
    const me = await this.me();
    const withMeta = arr.map(r => ['team', 'suppliers', 'library_prices', 'rfq_lines', 'quote_lines', 'po_lines', 'costing', 'selections'].includes(table) || r.created_by ? r : { ...r, created_by: me?.id });
    const { data, error } = await this.sb.from(table).insert(withMeta).select(); if (error) throw error;
    return Array.isArray(rows) ? data : data[0];
  }
  async update(table, id, patch) {
    const p = ['projects', 'areas', 'spec_items'].includes(table) ? { ...patch, updated_at: new Date().toISOString() } : patch;
    const { data, error } = await this.sb.from(table).update(p).eq('id', id).select().maybeSingle(); if (error) throw error; return data;
  }
  async upsert(table, row, onConflict) { const { data, error } = await this.sb.from(table).upsert(row, { onConflict }).select().maybeSingle(); if (error) throw error; return data; }
  async remove(table, id) { const { error } = await this.sb.from(table).delete().eq('id', id); if (error) throw error; }
  async removeWhere(table, match) { let q = this.sb.from(table).delete(); for (const [k, v] of Object.entries(match)) q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v); const { error } = await q; if (error) throw error; }
  async upload(bucket, path, file) { const { error } = await this.sb.storage.from(bucket).upload(path, file, { upsert: true, contentType: file.type }); if (error) throw error; return path; }
  async fileUrl(bucket, path) { const { data, error } = await this.sb.storage.from(bucket).createSignedUrl(path, 3600); if (error) throw error; return data.signedUrl; }
  async claude(action, payload) {
    const { data, error } = await this.sb.functions.invoke('claude', { body: { action, ...payload } });
    if (error) { let msg = error.message; try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch (e) { } throw new Error(msg); }
    if (data?.error) throw new Error(data.error);
    return data;
  }
}

// ----------------------------------------------------------------- Demo
const DB_KEY = 'dg-demo-db';
class DemoStore {
  constructor() { this.mode = 'demo'; this.db = this.load(); }
  load() { try { return JSON.parse(localStorage.getItem(DB_KEY) || '{}'); } catch (e) { return {}; } }
  save() { try { localStorage.setItem(DB_KEY, JSON.stringify(this.db)); } catch (e) { console.warn('Demo save failed', e); } }
  t(table) { return (this.db[table] = this.db[table] || []); }
  async session() { return { user: { id: 'demo-user' } }; }
  async me() { const role = localStorage.getItem('dg-demo-role') || 'admin'; return { id: 'demo-user', email: 'demo@dugreen.local', full_name: 'Demo user', role }; }
  async signOut() { }
  match(r, m) { return Object.entries(m).every(([k, v]) => v === null ? r[k] == null : Array.isArray(v) ? v.includes(r[k]) : r[k] === v); }
  async list(table, match = {}, order = 'created_at') {
    const rows = this.t(table).filter(r => this.match(r, match)).map(r => ({ ...r }));
    if (order) rows.sort((a, b) => { const x = a[order], y = b[order]; return typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? '')); });
    return rows;
  }
  async get(table, id) { const r = this.t(table).find(x => x.id === id); return r ? { ...r } : null; }
  async insert(table, rows) {
    const arr = (Array.isArray(rows) ? rows : [rows]).map((r, i) => ({ id: uid(), created_at: new Date(Date.now() + i).toISOString(), created_by: 'demo-user', ...r }));
    this.t(table).push(...arr); this.save();
    return Array.isArray(rows) ? arr.map(r => ({ ...r })) : { ...arr[0] };
  }
  async update(table, id, patch) { const r = this.t(table).find(x => x.id === id); if (!r) return null; Object.assign(r, patch, { updated_at: new Date().toISOString() }); this.save(); return { ...r }; }
  async upsert(table, row, onConflict) {
    const keys = onConflict.split(',').map(s => s.trim());
    const r = this.t(table).find(x => keys.every(k => x[k] === row[k]));
    if (r) { Object.assign(r, row); this.save(); return { ...r }; }
    return this.insert(table, row);
  }
  async remove(table, id) {
    for (const [child, fk] of CHILDREN[table] || []) for (const c of this.t(child).filter(x => x[fk] === id)) await this.remove(child, c.id);
    this.db[table] = this.t(table).filter(x => x.id !== id); this.save();
  }
  async removeWhere(table, match) { for (const r of this.t(table).filter(x => this.match(x, match))) await this.remove(table, r.id); }
  idb() {
    return new Promise((res, rej) => { const o = indexedDB.open('dg-demo-files', 1); o.onupgradeneeded = () => o.result.createObjectStore('f'); o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error); });
  }
  async upload(bucket, path, file) {
    const db = await this.idb();
    await new Promise((res, rej) => { const tx = db.transaction('f', 'readwrite'); tx.objectStore('f').put(file, bucket + '/' + path); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    return path;
  }
  async fileUrl(bucket, path) {
    const db = await this.idb();
    const blob = await new Promise((res, rej) => { const r = db.transaction('f').objectStore('f').get(bucket + '/' + path); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return blob ? URL.createObjectURL(blob) : null;
  }
  async claude() { throw new Error('Claude needs the app connected to its server (Settings → Server). Demo mode runs only in this browser.'); }
}

export function makeStore() {
  const cfg = serverConfig();
  const forceDemo = localStorage.getItem('dg-force-demo') === '1';
  if (cfg && !forceDemo && window.supabase) return new CloudStore(cfg);
  return new DemoStore();
}
