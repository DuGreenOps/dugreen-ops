// Shared helpers: escaping, formatting, ids, dialogs, toasts.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
export const num = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[ ,]/g, '')); return Number.isFinite(n) ? n : null; };
const nf = (d) => new Intl.NumberFormat('en-ZA', { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmt = (n, d = 0) => n == null || Number.isNaN(n) ? '–' : nf(d).format(n).replace(/ /g, ' ');
export const money = (n, d = 2) => n == null || Number.isNaN(n) ? '–' : 'E ' + fmt(n, d);
export const today = () => new Date().toISOString().slice(0, 10);
export const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '–';

// Normalised key that groups the "same product" across areas, RFQs, quotes and the library.
export function itemKey(description, spec, unit) {
  const n = s => String(s || '').toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9.]+/g, ' ').trim();
  return [n(description), n(spec), n(unit)].join('|');
}

export const UNITS = ['each', 'm²', 'm', 'm³', 'bag', 'load', 'kg', 'L', 'tray', 'roll', 'item', 'hour', 'day', 'week', 'month', 'trip'];
export const CATEGORIES = ['Plants', 'Trees', 'Lawn & grassing', 'Hardscaping', 'Irrigation & piping', 'Soil & fertiliser', 'Earthworks', 'Drainage', 'Structures & furniture', 'Labour', 'Plant hire & transport', 'Preliminaries', 'Maintenance', 'Other'];
export const AREA_TYPES = [
  { key: 'Garden', prefix: 'G', color: '#5CC245' },
  { key: 'Lawn', prefix: 'L', color: '#B7E34D' },
  { key: 'Hardscape', prefix: 'H', color: '#C9C2B4' },
  { key: 'Earthworks', prefix: 'A', color: '#E8A030' },
  { key: 'Irrigation', prefix: 'I', color: '#4FB3E0' },
  { key: 'Works', prefix: 'T', color: '#8C96FF' },
  { key: 'Other', prefix: 'X', color: '#E86FB0' },
];
export const typeColor = t => (AREA_TYPES.find(a => a.key === t) || AREA_TYPES[AREA_TYPES.length - 1]).color;
export const ROLES = { admin: 'Admin', qs: 'Quantity Surveyor', horticulturist: 'Horticulturist', procurement: 'Procurement', viewer: 'Viewer', pending: 'Awaiting access' };

export function toast(msg, ms = 2800) {
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), ms);
}

// Modal dialog. `body` is HTML; `onOpen(el)` wires inputs; buttons resolve the promise.
export function dialog({ title, body = '', buttons = [{ label: 'Close', value: null }], wide = false, onOpen }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'dlg-back';
    wrap.innerHTML = `<div class="dlg ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="dlg-head"><h3>${esc(title)}</h3><button class="icon-btn" data-x aria-label="Close">✕</button></div>
      <div class="dlg-body">${body}</div>
      <div class="dlg-foot">${buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    const close = v => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', async e => {
      if (e.target === wrap || e.target.closest('[data-x]')) return close(null);
      const b = e.target.closest('[data-i]'); if (!b) return;
      const def = buttons[+b.dataset.i];
      if (def.validate) { const ok = await def.validate(wrap); if (!ok) return; }
      close(typeof def.value === 'function' ? def.value(wrap) : def.value);
    });
    document.body.append(wrap);
    onOpen && onOpen(wrap);
    const f = wrap.querySelector('input,select,textarea'); f && setTimeout(() => f.focus(), 30);
  });
}
export const confirmDlg = (title, text, label = 'Delete') =>
  dialog({ title, body: `<p>${esc(text)}</p>`, buttons: [{ label: 'Cancel', value: false }, { label, value: true, danger: true }] });

export function formData(root) {
  const o = {};
  root.querySelectorAll('[name]').forEach(el => {
    if (el.type === 'checkbox') { if (!(el.name in o)) o[el.name] = el.dataset.multi ? [] : false; if (el.dataset.multi) { if (el.checked) o[el.name].push(el.value); } else o[el.name] = el.checked; }
    else o[el.name] = el.value;
  });
  return o;
}

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => fallback());
  return Promise.resolve(fallback());
  function fallback() {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e) { } ta.remove(); return ok;
  }
}

export function downloadFile(name, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const groupBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); (m[k] = m[k] || []).push(x); return m; }, {});
export const sum = (arr, f = x => x) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
export const byNatural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
