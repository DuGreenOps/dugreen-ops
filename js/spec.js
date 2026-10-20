// Specification: the QS and Horticulturist list what goes into each area.
// Quantities can follow the area's measurements (per m², per m, per point) so they update when areas change.
// Transport lines plan truck loads / LDV trips, optionally worked out from a material's volume.
import { esc, fmt, money, dialog, formData, toast, confirmDlg, num, itemKey, UNITS, CATEGORIES, VEHICLES, typeColor, groupBy } from './util.js';
import { areaMeasures } from './geo.js';
import { sortAreas, measureText } from './areas.js';
import { getSetting } from './store.js';

const EACH_UNITS = ['each', 'bag', 'load', 'tray', 'roll', 'item', 'trip'];
export const QTY_MODES = { manual: 'I’ll enter the quantity', per_m2: 'Rate per m² of the area', per_m: 'Rate per metre (length / perimeter)', per_no: 'Rate per point / count' };

// lookup = { items, areasById } lets transport lines read the quantity of the material they carry.
export function computeQty(item, area, lookup) {
  const tr = item.meta?.transport;
  if (tr) {
    let n;
    if (tr.basis === 'trip') n = (Number(tr.trips_per_day) || 0) * (Number(tr.days) || 0);
    else if (tr.from_item && lookup) {
      const src = lookup.items.find(i => i.id === tr.from_item);
      const q = src ? computeQty(src, lookup.areasById[src.area_id]) : 0;
      n = tr.capacity ? Math.ceil(q / Number(tr.capacity) - 1e-9) : 0;
    } else n = Number(tr.loads) || Number(item.qty) || 0;
    return n;
  }
  let base;
  if (item.qty_mode === 'per_m2' || item.qty_mode === 'per_m' || item.qty_mode === 'per_no') {
    const m = area ? areaMeasures(area) : {};
    const basis = item.qty_mode === 'per_m2' ? m.area : item.qty_mode === 'per_m' ? (m.length || m.perimeter) : m.count;
    base = (Number(basis) || 0) * (Number(item.rate) || 0);
  } else base = Number(item.qty) || 0;
  let q = base * (1 + (Number(item.allowance_pct) || 0) / 100);
  if (EACH_UNITS.includes(item.unit)) q = Math.ceil(q - 1e-9);
  else q = Math.round(q * 100) / 100;
  return q;
}

// Group spec lines across areas into procurement items (same product = same item_key).
export function procurementItems(items, areas) {
  const byId = Object.fromEntries(areas.map(a => [a.id, a]));
  const lookup = { items, areasById: byId };
  const g = {};
  for (const it of items) {
    const k = it.item_key;
    const q = computeQty(it, byId[it.area_id], lookup);
    if (!g[k]) g[k] = { item_key: k, category: it.category, description: it.description, spec: it.spec, unit: it.unit, qty: 0, unit_cost: null, transport: !!it.meta?.transport, lines: [] };
    g[k].qty += q; g[k].lines.push({ ...it, qty_calc: q, area: byId[it.area_id] || null });
    if (g[k].unit_cost == null && it.unit_cost != null) g[k].unit_cost = Number(it.unit_cost);
  }
  return Object.values(g).sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.description.localeCompare(b.description));
}

export async function vehicleList(store) { return await getSetting(store, 'vehicles', VEHICLES) || VEHICLES; }

function ruleText(i, items) {
  const tr = i.meta?.transport;
  if (tr) {
    if (tr.basis === 'trip') return `${fmt(tr.trips_per_day)} trip${tr.trips_per_day == 1 ? '' : 's'}/day × ${fmt(tr.days)} days`;
    if (tr.from_item) { const s = items.find(x => x.id === tr.from_item); return `Loads for ${esc(s?.description || 'material')} at ${fmt(tr.capacity, 1)} ${esc(s?.unit || '')}/load`; }
    return 'Loads entered';
  }
  return i.qty_mode && i.qty_mode !== 'manual' ? `${fmt(i.rate, 2)} ${({ per_m2: 'per m²', per_m: 'per m', per_no: 'per point' })[i.qty_mode]}` : 'Entered';
}

export async function render(root, ctx) {
  const { store, project } = ctx;
  const [areasRaw, items, lib] = await Promise.all([
    store.list('areas', { project_id: project.id }), store.list('spec_items', { project_id: project.id }, 'sort'), store.list('library_prices', {}, null)]);
  const areas = sortAreas(areasRaw);
  const areasById = Object.fromEntries(areas.map(a => [a.id, a]));
  const lookup = { items, areasById };
  const filter = ctx.rest?.[0] || 'all';
  const groups = [...areas.map(a => ({ id: a.id, area: a })), { id: 'site', area: null }];
  const shown = groups.filter(g => filter === 'all' || filter === g.id);
  const byArea = groupBy(items, i => i.area_id || 'site');
  const suggestions = [...new Map([...lib.map(l => [l.item_key, l]), ...items.map(i => [i.item_key, i])]).values()];

  root.innerHTML = `<div class="page">
    <div class="row"><div class="grow"><div class="eyebrow">QS and Horticulturist</div><h2 style="font-size:24px">Specification</h2>
      <p class="small muted" style="margin:2px 0 0">List the plants, grass, hardscaping, piping, transport and works for each area. Quantities linked to an area update when its measurements change.</p></div>
      <label class="f" style="min-width:200px">Show<select id="flt"><option value="all">All areas</option>${areas.map(a => `<option value="${a.id}" ${filter === a.id ? 'selected' : ''}>${esc(a.code || '')} ${esc(a.name || a.type || '')}</option>`).join('')}<option value="site" ${filter === 'site' ? 'selected' : ''}>Site-wide items</option></select></label></div>
    ${!areas.length ? `<div class="card empty"><b>No areas yet</b>Add areas first (on the map or by hand), or add site-wide items below.</div>` : ''}
    ${shown.map(g => {
      const its = byArea[g.id] || [];
      const a = g.area;
      return `<section class="card">
        <div class="hd">${a ? `<span class="code" style="background:${typeColor(a.type)}">${esc(a.code || '—')}</span><h3>${esc(a.name || a.type || 'Area')}</h3><span class="small muted">${measureText(a)}</span>` : '<h3>Site-wide items</h3><span class="small muted">Prelims, labour, transport, items not tied to one area</span>'}
          <span class="grow"></span>
          ${a ? `<button class="btn small" data-sug="${a.id}">✦ Suggest with Claude</button>` : ''}
          <button class="btn small" data-tr="${g.id}">🚚 Transport</button>
          <button class="btn small primary" data-add="${g.id}">+ Add item</button></div>
        ${its.length ? `<div class="tbl"><table><thead><tr><th>Category</th><th>Item</th><th>Spec / size</th><th>Quantity rule</th><th class="n">Qty</th><th>Unit</th><th class="n">QS cost</th></tr></thead><tbody>
          ${its.map(i => `<tr class="click" data-it="${i.id}"><td class="small">${esc(i.category || '')}</td><td><b>${esc(i.description)}</b>${i.notes ? `<div class="small muted">${esc(i.notes)}</div>` : ''}</td><td class="small">${esc(i.spec || '')}</td>
            <td class="small muted">${ruleText(i, items)}${Number(i.allowance_pct) && !i.meta?.transport ? ` + ${fmt(i.allowance_pct)}%` : ''}</td>
            <td class="n"><b>${fmt(computeQty(i, a, lookup), 2)}</b></td><td>${esc(i.unit || '')}</td><td class="n small">${i.unit_cost != null ? money(Number(i.unit_cost)) : '–'}</td></tr>`).join('')}
        </tbody></table></div>` : `<div class="empty small">Nothing specified yet.</div>`}
      </section>`;
    }).join('')}
    <datalist id="dl-items">${suggestions.map(s => `<option value="${esc(s.description)}">${esc([s.spec, s.unit].filter(Boolean).join(' · '))}</option>`).join('')}</datalist>
  </div>`;

  const opts = { areas, suggestions, items, count: items.length };
  root.querySelector('#flt').onchange = e => ctx.go(`#/p/${project.id}/spec${e.target.value === 'all' ? '' : '/' + e.target.value}`);
  root.querySelectorAll('[data-add]').forEach(b => b.onclick = async () => { if (await editItem(ctx, null, { ...opts, areaId: b.dataset.add === 'site' ? null : b.dataset.add })) ctx.reload(); });
  root.querySelectorAll('[data-tr]').forEach(b => b.onclick = async () => { if (await editItem(ctx, null, { ...opts, areaId: b.dataset.tr === 'site' ? null : b.dataset.tr, transport: true })) ctx.reload(); });
  root.querySelectorAll('[data-it]').forEach(r => r.onclick = async () => { if (await editItem(ctx, items.find(i => i.id === r.dataset.it), opts)) ctx.reload(); });
  root.querySelectorAll('[data-sug]').forEach(b => b.onclick = () => suggest(ctx, areas.find(a => a.id === b.dataset.sug), byArea[b.dataset.sug] || [], items.length));
}

export async function editItem(ctx, item, { areas, areaId = null, suggestions = [], items = [], count = 0, transport = false }) {
  const { store, project } = ctx;
  const vehicles = await vehicleList(store);
  const isTr = !!(item?.meta?.transport) || transport;
  const tr0 = item?.meta?.transport || { vehicle: vehicles[0].key, basis: vehicles[0].basis, loads: '', capacity: vehicles[0].capacity_m3 ?? '', trips_per_day: 1, days: '', cost: vehicles[0].cost ?? '' };
  const cur = item || { area_id: areaId, category: isTr ? 'Transport' : 'Plants', unit: isTr ? 'load' : 'each', qty_mode: areaId ? 'per_m2' : 'manual', allowance_pct: 0 };
  const areaOf = id => areas.find(a => a.id === id);
  const areasById = Object.fromEntries(areas.map(a => [a.id, a]));
  const carriable = items.filter(i => !i.meta?.transport && (!item || i.id !== item.id));

  const trPanel = `<div class="dims" id="trp" ${isTr || cur.category === 'Transport' ? '' : 'hidden'}>
      <b style="font-family:var(--display)">🚚 Transport plan</b>
      <div class="grid2"><label class="f">Vehicle<select name="tr_vehicle">${vehicles.map(v => `<option ${tr0.vehicle === v.key ? 'selected' : ''}>${esc(v.key)}</option>`).join('')}</select></label>
        <label class="f">Plan by<select name="tr_basis"><option value="load" ${tr0.basis !== 'trip' ? 'selected' : ''}>Number of loads</option><option value="trip" ${tr0.basis === 'trip' ? 'selected' : ''}>Daily trips (e.g. LDV)</option></select></label></div>
      <div data-b="load" class="stack" style="gap:8px">
        <label class="f">Loads worked out from<select name="tr_from"><option value="">I’ll enter the number of loads</option>${carriable.map(i => `<option value="${i.id}" ${tr0.from_item === i.id ? 'selected' : ''}>${esc(i.description)} · ${fmt(computeQty(i, areasById[i.area_id]), 2)} ${esc(i.unit)}${i.area_id && areasById[i.area_id] ? ' · ' + esc(areasById[i.area_id].code || '') : ''}</option>`).join('')}</select></label>
        <div class="grid2"><label class="f" data-f="loads">Number of loads<input name="tr_loads" inputmode="decimal" value="${tr0.loads ?? ''}"></label>
          <label class="f" data-f="cap">Carries per load<input name="tr_cap" inputmode="decimal" value="${tr0.capacity ?? ''}" placeholder="e.g. 6 (m³)"></label></div></div>
      <div data-b="trip" class="grid2"><label class="f">Trips per day<input name="tr_tpd" inputmode="decimal" value="${tr0.trips_per_day ?? 1}"></label>
        <label class="f">Number of days<input name="tr_days" inputmode="decimal" value="${tr0.days ?? ''}"></label></div>
      <label class="f"><span>Cost per <span id="tr-u">load</span> (E)</span><input name="tr_cost" inputmode="decimal" value="${tr0.cost ?? item?.unit_cost ?? ''}"></label>
    </div>`;

  const body = `
    <label class="f">Area<select name="area_id"><option value="">Site-wide (not tied to an area)</option>${areas.map(a => `<option value="${a.id}" ${cur.area_id === a.id ? 'selected' : ''}>${esc(a.code || '')} ${esc(a.name || a.type || '')} · ${measureText(a)}</option>`).join('')}</select></label>
    <div class="grid2"><label class="f">Category<select name="category">${CATEGORIES.map(c => `<option ${cur.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="f">Unit<select name="unit">${UNITS.map(u => `<option ${cur.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label></div>
    <label class="f">Item<input name="description" list="dl-items" value="${esc(cur.description)}" placeholder="${isTr ? 'Filled in from the vehicle if left blank' : 'e.g. Blue Plumbago, Kikuyu instant lawn, 110mm drainage pipe'}"></label>
    <label class="f">${isTr ? 'What it carries / purpose' : 'Spec / size / botanical name'}<input name="spec" value="${esc(cur.spec)}" placeholder="${isTr ? 'e.g. Topsoil to site, plants from nursery' : 'e.g. Plumbago auriculata, 4L bag'}"></label>
    ${trPanel}
    <div class="dims" id="qtyp" ${isTr ? 'hidden' : ''}>
      <label class="f">How is the quantity worked out?<select name="qty_mode">${Object.entries(QTY_MODES).map(([k, l]) => `<option value="${k}" ${cur.qty_mode === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="grid3"><label class="f" data-show="manual">Quantity<input name="qty" inputmode="decimal" value="${cur.qty ?? ''}"></label>
        <label class="f" data-show="rate"><span id="rate-l">Rate</span><input name="rate" inputmode="decimal" value="${cur.rate ?? ''}" placeholder="e.g. 4"></label>
        <label class="f">Allowance %<input name="allowance_pct" inputmode="decimal" value="${cur.allowance_pct ?? 0}" placeholder="10 = mortality"></label></div></div>
    <div class="dims" style="background:var(--accent-soft)"><div class="row"><div class="grow"><div class="small muted" id="qnote"></div><div style="font:700 26px/1.1 var(--display)" id="qres">–</div></div>
      <label class="f" style="width:160px">QS cost estimate (E per unit)<input name="unit_cost" inputmode="decimal" value="${cur.unit_cost ?? ''}" placeholder="optional"></label></div>
      <div class="small muted">Used in Costing when no supplier price has been selected.</div></div>
    <label class="f">Notes<textarea name="notes" placeholder="Spacing, planting notes, supplier preference…">${esc(cur.notes)}</textarea></label>`;

  const readTr = f => ({ vehicle: f.tr_vehicle, basis: f.tr_basis, from_item: f.tr_basis === 'load' ? (f.tr_from || null) : null, loads: num(f.tr_loads), capacity: num(f.tr_cap), trips_per_day: num(f.tr_tpd), days: num(f.tr_days), cost: num(f.tr_cost) });
  const calc = w => {
    const f = formData(w);
    const trOn = f.category === 'Transport';
    w.querySelector('#trp').hidden = !trOn; w.querySelector('#qtyp').hidden = trOn;
    const a = areaOf(f.area_id);
    if (trOn) {
      const t = readTr(f);
      w.querySelectorAll('[data-b]').forEach(el => el.hidden = el.dataset.b !== t.basis);
      w.querySelector('[data-f=loads]').hidden = !!t.from_item; w.querySelector('[data-f=cap]').hidden = !t.from_item;
      w.querySelector('#tr-u').textContent = t.basis === 'trip' ? 'trip' : 'load';
      const n = computeQty({ meta: { transport: t } }, null, { items, areasById });
      const src = t.from_item ? items.find(i => i.id === t.from_item) : null;
      w.querySelector('#qnote').innerHTML = src ? `${fmt(computeQty(src, areasById[src.area_id]), 2)} ${esc(src.unit)} of ${esc(src.description)} ÷ ${fmt(t.capacity, 1)} per load` : t.basis === 'trip' ? `${fmt(t.trips_per_day)} trips × ${fmt(t.days)} days` : 'Loads';
      w.querySelector('#qres').innerHTML = `${fmt(n)} ${t.basis === 'trip' ? 'trips' : 'loads'}${t.cost != null ? ` <span style="font-size:16px" class="muted">× ${money(t.cost)} = ${money(n * t.cost)}</span>` : ''}`;
      return;
    }
    const it = { ...f, qty: num(f.qty), rate: num(f.rate), allowance_pct: num(f.allowance_pct) };
    const manual = f.qty_mode === 'manual';
    w.querySelector('[data-show=manual]').hidden = !manual;
    w.querySelector('[data-show=rate]').hidden = manual;
    w.querySelector('#rate-l').textContent = { per_m2: `${f.unit} per m²`, per_m: `${f.unit} per metre`, per_no: `${f.unit} per point` }[f.qty_mode] || 'Rate';
    let note = '';
    if (!manual && !a) note = '<span class="flag">Choose an area above so the rate can be applied.</span>';
    else if (!manual) { const m = areaMeasures(a); const basis = f.qty_mode === 'per_m2' ? `${fmt(m.area, 2)} m²` : f.qty_mode === 'per_m' ? `${fmt(m.length || m.perimeter, 2)} m` : `${fmt(m.count)} points`; note = `${basis} × ${fmt(it.rate, 2)}${it.allowance_pct ? ` + ${fmt(it.allowance_pct)}%` : ''}`; }
    else note = 'Entered quantity' + (it.allowance_pct ? ` + ${fmt(it.allowance_pct)}%` : '');
    w.querySelector('#qnote').innerHTML = note;
    const q = computeQty(it, a);
    const uc = num(f.unit_cost);
    w.querySelector('#qres').innerHTML = `${fmt(q, 2)} ${esc(f.unit)}${uc != null ? ` <span style="font-size:16px" class="muted">× ${money(uc)} = ${money(q * uc)}</span>` : ''}`;
  };
  const v = await dialog({
    title: item ? 'Edit spec line' : isTr ? 'Add transport' : 'Add spec line', wide: true, body,
    onOpen: w => {
      w.querySelectorAll('input,select,textarea').forEach(el => { el.addEventListener('input', () => calc(w)); el.addEventListener('change', () => calc(w)); });
      // Picking an area for a typed quantity switches to a per-m² rate (what the QS almost always wants).
      w.querySelector('[name=area_id]').addEventListener('change', e => {
        const mode = w.querySelector('[name=qty_mode]');
        const a = areaOf(e.target.value);
        if (a && mode.value === 'manual' && !w.querySelector('[name=qty]').value) { const m = areaMeasures(a); mode.value = m.area ? 'per_m2' : m.length ? 'per_m' : m.count ? 'per_no' : 'manual'; calc(w); }
      });
      w.querySelector('[name=category]').addEventListener('change', e => { if (e.target.value === 'Transport') { w.querySelector('[name=unit]').value = w.querySelector('[name=tr_basis]').value === 'trip' ? 'trip' : 'load'; } calc(w); });
      w.querySelector('[name=tr_basis]').addEventListener('change', e => { w.querySelector('[name=unit]').value = e.target.value === 'trip' ? 'trip' : 'load'; calc(w); });
      w.querySelector('[name=tr_vehicle]').addEventListener('change', e => {
        const vh = vehicles.find(x => x.key === e.target.value); if (!vh) return;
        w.querySelector('[name=tr_basis]').value = vh.basis; w.querySelector('[name=unit]').value = vh.basis === 'trip' ? 'trip' : 'load';
        if (vh.cost != null) w.querySelector('[name=tr_cost]').value = vh.cost;
        if (vh.capacity_m3 != null) w.querySelector('[name=tr_cap]').value = vh.capacity_m3;
        calc(w);
      });
      w.querySelector('[name=tr_from]').addEventListener('change', e => { const s = items.find(i => i.id === e.target.value); if (s && !w.querySelector('[name=spec]').value) w.querySelector('[name=spec]').value = s.description + ' to site'; calc(w); });
      w.querySelector('[name=description]').addEventListener('change', e => { const s = suggestions.find(x => x.description === e.target.value); if (s) { if (s.spec && !w.querySelector('[name=spec]').value) w.querySelector('[name=spec]').value = s.spec; if (s.unit) w.querySelector('[name=unit]').value = s.unit; if (s.category) w.querySelector('[name=category]').value = s.category; calc(w); } });
      calc(w);
    },
    buttons: [...(item ? [{ label: 'Delete', danger: true, value: 'delete' }] : []), { label: 'Cancel', value: null },
      { label: item ? 'Save' : 'Add', primary: true, value: w => formData(w), validate: w => { const f = formData(w); if (f.category !== 'Transport' && !f.description.trim()) { toast('Enter the item name.'); return false; } return true; } }],
  });
  if (!v) return null;
  if (v === 'delete') { if (await confirmDlg('Delete spec line?', item.description)) { await store.remove('spec_items', item.id); return 'deleted'; } return null; }
  let row;
  if (v.category === 'Transport') {
    const t = readTr(v);
    const n = computeQty({ meta: { transport: t } }, null, { items, areasById });
    row = { project_id: project.id, area_id: v.area_id || null, category: 'Transport', description: (v.description.trim() || `Transport – ${t.vehicle}`), spec: v.spec.trim() || null,
      unit: t.basis === 'trip' ? 'trip' : 'load', qty_mode: 'manual', qty: n, rate: null, allowance_pct: 0, unit_cost: t.cost ?? num(v.unit_cost), notes: v.notes || null, meta: { transport: t } };
  } else {
    row = { project_id: project.id, area_id: v.area_id || null, category: v.category, description: v.description.trim(), spec: v.spec.trim() || null, unit: v.unit,
      qty_mode: v.qty_mode, rate: num(v.rate), qty: num(v.qty), allowance_pct: num(v.allowance_pct) || 0, unit_cost: num(v.unit_cost), notes: v.notes || null, meta: null };
    if (row.qty_mode !== 'manual' && !row.area_id) row.qty_mode = 'manual';
  }
  row.item_key = itemKey(row.description, row.spec, row.unit);
  const saved = item ? await store.update('spec_items', item.id, row) : await store.insert('spec_items', { ...row, sort: count });
  toast(item ? 'Saved' : 'Added');
  return saved;
}

// Claude suggests a specification for one area; the user ticks what to keep.
async function suggest(ctx, area, existing, count) {
  const { store, project } = ctx;
  const m = areaMeasures(area);
  toast('Asking Claude for a spec…', 6000);
  let res;
  try {
    res = await store.claude('suggest_spec', {
      project: { name: project.name, client: project.client, site: project.site_address },
      area: { code: area.code, name: area.name, type: area.type, notes: area.notes, area_m2: m.area, length_m: m.length, count: m.count },
      existing: existing.map(e => ({ description: e.description, spec: e.spec, unit: e.unit })),
    });
  } catch (e) { return dialog({ title: 'Claude is not available', body: `<p>${esc(e.message)}</p>` }); }
  const items = res.items || [];
  if (!items.length) return dialog({ title: 'No suggestions', body: `<p>${esc(res.note || 'Claude had nothing to add for this area.')}</p>` });
  const pick = await dialog({
    title: `Claude's suggestions for ${area.code || 'this area'}`, wide: true,
    body: `${res.note ? `<p class="muted">${esc(res.note)}</p>` : ''}<div class="tbl"><table><thead><tr><th></th><th>Item</th><th>Spec</th><th>Rule</th><th>Unit</th></tr></thead><tbody>
      ${items.map((it, i) => `<tr><td><input type="checkbox" name="pick" data-multi="1" value="${i}" checked aria-label="Add ${esc(it.description)}"></td><td><b>${esc(it.description)}</b><div class="small muted">${esc(it.category || '')}${it.notes ? ' · ' + esc(it.notes) : ''}</div></td><td class="small">${esc(it.spec || '')}</td>
        <td class="small">${it.qty_mode === 'manual' ? fmt(it.qty, 2) : `${fmt(it.rate, 2)} ${({ per_m2: 'per m²', per_m: 'per m', per_no: 'per point' })[it.qty_mode] || ''}`}</td><td>${esc(it.unit || '')}</td></tr>`).join('')}
    </tbody></table></div><p class="note">Suggestions are a starting point for the Horticulturist to check, not a final spec.</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Add ticked items', primary: true, value: w => formData(w).pick }],
  });
  if (!pick || !pick.length) return;
  const rows = pick.map((i, k) => {
    const it = items[+i];
    const unit = UNITS.includes(it.unit) ? it.unit : 'each';
    const qty_mode = QTY_MODES[it.qty_mode] ? it.qty_mode : 'manual';
    return { project_id: project.id, area_id: area.id, category: CATEGORIES.includes(it.category) ? it.category : 'Other', description: it.description, spec: it.spec || null, unit,
      qty_mode, rate: num(it.rate), qty: num(it.qty), allowance_pct: num(it.allowance_pct) || 0, notes: it.notes || null, item_key: itemKey(it.description, it.spec, unit), sort: count + k };
  });
  await store.insert('spec_items', rows);
  toast(`Added ${rows.length} lines`); ctx.reload();
}
