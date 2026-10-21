// Shared helpers: escaping, formatting, ids, dialogs, toasts.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
// Accepts "1 250.5", "1,250.5" and decimal commas like "0,5" or "12,75".
export const num = v => {
  if (v === '' || v == null) return null;
  let s = String(v).trim().replace(/\s/g, '');
  if (s.includes(',') && !s.includes('.')) { const tail = s.split(',').pop(); s = tail.length === 3 && s.split(',').length > 1 && !/^0,/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.'); }
  else s = s.replace(/,/g, '');
  const n = Number(s); return Number.isFinite(n) ? n : null;
};
const nf = (d) => new Intl.NumberFormat('en-ZA', { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmt = (n, d = 0) => n == null || Number.isNaN(n) ? '–' : nf(d).format(n).replace(/ /g, ' ');
export const money = (n, d = 2) => n == null || Number.isNaN(n) ? '–' : 'E ' + fmt(n, d);
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '–';

// Normalised key that groups the "same product" across areas, RFQs, quotes and the library.
export function itemKey(description, spec, unit) {
  const n = s => String(s || '').toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9.]+/g, ' ').trim();
  return [n(description), n(spec), n(unit)].join('|');
}

export const UNITS = ['each', 'm²', 'm', 'm³', 'bag', 'load', 'kg', 'L', 'tray', 'roll', 'item', 'hour', 'day', 'week', 'month', 'trip'];
export const CATEGORIES = ['Plants', 'Trees', 'Lawn & grassing', 'Hardscaping', 'Irrigation & piping', 'Soil & fertiliser', 'Earthworks', 'Drainage', 'Structures & furniture', 'Subcontractors', 'Labour', 'Transport', 'Plant hire & transport', 'Preliminaries', 'Maintenance', 'Other'];
// Transport planning presets (cost is entered by the QS; defaults can be changed in Settings).
export const VEHICLES = [
  { key: '8t truck', basis: 'load', capacity_m3: 6, cost: null },
  { key: '4t truck', basis: 'load', capacity_m3: 3, cost: null },
  { key: 'Tipper 10m³', basis: 'load', capacity_m3: 10, cost: null },
  { key: 'LDV (bakkie)', basis: 'trip', capacity_m3: 1, cost: null },
  { key: 'Flatbed / lowbed', basis: 'load', capacity_m3: null, cost: null },
  { key: 'Water cart', basis: 'trip', capacity_m3: null, cost: null },
];
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
export const ROLES = { admin: 'Admin', ops: 'Operations Manager', qs: 'Quantity Surveyor', horticulturist: 'Horticulturist', procurement: 'Procurement', supervisor: 'Site Supervisor', viewer: 'Viewer', pending: 'Awaiting access' };
// Date-only maths in UTC so it never shifts a day in Eswatini (UTC+2) or anywhere else.
export const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
export const weekStart = d => { const x = new Date(d + 'T00:00:00Z'); const wd = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - wd); return x.toISOString().slice(0, 10); };

export function toast(msg, ms = 2800) {
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), ms);
}

// Modal dialog. `body` is HTML; `onOpen(el)` wires inputs; buttons resolve the promise.
export function dialog({ title, body = '', buttons = [{ label: 'Close', value: null }], wide = false, onOpen, sticky = false }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'dlg-back';
    wrap.innerHTML = `<div class="dlg ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="dlg-head"><h3>${esc(title)}</h3><button class="icon-btn" data-x aria-label="Close">✕</button></div>
      <div class="dlg-body">${body}</div>
      <div class="dlg-foot">${buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}" data-dlg-btn="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    const close = v => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', async e => {
      if (e.target === wrap && sticky) return; // long forms: a stray tap outside must not lose the data
      if (e.target === wrap || e.target.closest('[data-x]')) return close(null);
      const b = e.target.closest('[data-dlg-btn]'); if (!b || !wrap.querySelector('.dlg-foot').contains(b)) return;
      const def = buttons[+b.dataset.dlgBtn];
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

// People on site: staff, casual workers and subcontractors (v3).
export const PERSON_KINDS = { staff: 'Staff', casual: 'Casual', subcontractor: 'Subcontractor' };
export const PAY_BASIS = { day: 'Daily rate', hour: 'Hourly rate', month: 'Monthly fee / salary', job: 'Job / lump-sum fee', rate: 'Measured rates' };
export const WORKDAYS_PER_MONTH = 26; // Mon–Sat; used to cost monthly staff per day on site
export const canSetRates = me => ['admin', 'qs', 'ops', 'procurement'].includes(me?.role);
export const isManager = me => ['admin', 'qs', 'ops'].includes(me?.role);
export const canStores = me => ['admin', 'ops', 'procurement'].includes(me?.role);
// Approvals: Matt (admin) approves anything; Ops manager and Procurement up to their limit (Settings).
export const DEFAULT_LIMITS = { ops: 5000, procurement: 5000 };
export function approvalCheck(me, value, limits = DEFAULT_LIMITS) {
  const r = me?.role;
  if (r === 'admin') return { ok: true };
  if (r === 'ops' || r === 'procurement') { const lim = Number(limits?.[r] ?? DEFAULT_LIMITS[r]); return (Number(value) || 0) <= lim ? { ok: true } : { ok: false, why: `Above your approval limit of E ${fmt(lim)} – Matt must approve.` }; }
  return { ok: false, why: 'Only Matt, the Operations Manager or Procurement can approve.' };
}

// Tools & equipment commonly on a Du Green site (the supervisor can type anything else).
export const TOOL_LIST = ['Spade', 'Shovel', 'Garden fork', 'Rake (steel)', 'Rake (leaf)', 'Hoe', 'Pick / mattock', 'Crowbar', 'Wheelbarrow', 'Secateurs', 'Loppers', 'Hedge shears', 'Pruning saw', 'Bow saw', 'Slasher', 'Hand trowel', 'Hand fork', 'Edging tool / half-moon', 'Tape measure', 'Spirit level', 'String line & pegs', 'Hammer', 'Sledgehammer', 'Watering can', 'Hose pipe', 'Knapsack sprayer', 'Tamper (hand)', 'Buckets',
  'Brushcutter', 'Push mower', 'Ride-on mower', 'Hedge trimmer', 'Chainsaw', 'Leaf blower', 'Rotavator / tiller', 'Plate compactor', 'Water pump', 'Generator', 'Pole pruner', 'Scarifier', 'Auger', 'Angle grinder',
  'TLB', 'Tipper truck', 'Bakkie (LDV)', 'Tractor', 'Water cart', 'Trailer'];
export const MOTORISED = ['Brushcutter', 'Push mower', 'Ride-on mower', 'Hedge trimmer', 'Chainsaw', 'Leaf blower', 'Rotavator / tiller', 'Plate compactor', 'Water pump', 'Generator', 'Pole pruner', 'Scarifier', 'Auger', 'TLB', 'Tipper truck', 'Bakkie (LDV)', 'Tractor', 'Water cart'];
export const FUEL_TYPES = ['Petrol', 'Diesel', '2-stroke mix', 'Engine oil', '2-stroke oil'];
export const STOCK_CATS = ['Hand tools', 'Power tools & machines', 'Vehicles & plant', 'PPE', 'Fuel & oils', 'Irrigation fittings', 'Fertiliser & chemicals', 'Consumables', 'Building materials', 'Plants & seed', 'Other'];
export const EQUIP_ISSUE_KINDS = ['Damaged', 'Broken', 'Breakdown', 'Needs service', 'Lost', 'Stolen', 'Worn out'];

