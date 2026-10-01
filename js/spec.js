// Specification: the QS and Horticulturist list what goes into each area.
// Quantities can follow the area's measurements (per m², per m, per point) so they update when areas change.
import { esc, fmt, dialog, formData, toast, confirmDlg, num, itemKey, UNITS, CATEGORIES, typeColor, groupBy } from './util.js';
import { areaMeasures } from './geo.js';
import { sortAreas, measureText } from './areas.js';

const EACH_UNITS = ['each', 'bag', 'load', 'tray', 'roll', 'item', 'trip'];
export const QTY_MODES = { manual: 'Enter quantity', per_m2: 'Per m² of the area', per_m: 'Per metre of length / perimeter', per_no: 'Per point / count' };

export function computeQty(item, area) {
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
  const g = {};
  for (const it of items) {
    const k = it.item_key;
    const q = computeQty(it, byId[it.area_id]);
    if (!g[k]) g[k] = { item_key: k, category: it.category, description: it.description, spec: it.spec, unit: it.unit, qty: 0, lines: [] };
    g[k].qty += q; g[k].lines.push({ ...it, qty_calc: q, area: byId[it.area_id] || null });
  }
  return Object.values(g).sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.description.localeCompare(b.description));
}

export async function render(root, ctx) {
  const { store, project } = ctx;
  const [areasRaw, items, lib] = await Promise.all([
    store.list('areas', { project_id: project.id }), store.list('spec_items', { project_id: project.id }, 'sort'), store.list('library_prices', {}, null)]);
  const areas = sortAreas(areasRaw);
  const filter = ctx.rest?.[0] || 'all';
  const groups = [...areas.map(a => ({ id: a.id, area: a })), { id: 'site', area: null }];
  const shown = groups.filter(g => filter === 'all' || filter === g.id);
  const byArea = groupBy(items, i => i.area_id || 'site');
  const suggestions = [...new Map([...lib.map(l => [l.item_key, l]), ...items.map(i => [i.item_key, i])]).values()];

  root.innerHTML = `<div class="page">
    <div class="row"><div class="grow"><div class="eyebrow">QS and Horticulturist</div><h2 style="font-size:24px">Specification</h2>
      <p class="small muted" style="margin:2px 0 0">List the plants, grass, hardscaping, piping and works for each area. Quantities linked to an area update when its measurements change.</p></div>
      <label class="f" style="min-width:200px">Show<select id="flt"><option value="all">All areas</option>${areas.map(a => `<option value="${a.id}" ${filter === a.id ? 'selected' : ''}>${esc(a.code || '')} ${esc(a.name || a.type || '')}</option>`).join('')}<option value="site" ${filter === 'site' ? 'selected' : ''}>Site-wide items</option></select></label></div>
    ${!areas.length ? `<div class="card empty"><b>No areas yet</b>Add areas first (on the map or by hand), or add site-wide items below.</div>` : ''}
    ${shown.map(g => {
      const its = byArea[g.id] || [];
      const a = g.area;
      return `<section class="card">
        <div class="hd">${a ? `<span class="code" style="background:${typeColor(a.type)}">${esc(a.code || '—')}</span><h3>${esc(a.name || a.type || 'Area')}</h3><span class="small muted">${measureText(a)}</span>` : '<h3>Site-wide items</h3><span class="small muted">Prelims, labour, transport, items not tied to one area</span>'}
          <span class="grow"></span>
          ${a ? `<button class="btn small" data-sug="${a.id}">✦ Suggest with Claude</button>` : ''}
          <button class="btn small primary" data-add="${g.id}">+ Add item</button></div>
        ${its.length ? `<div class="tbl"><table><thead><tr><th>Category</th><th>Item</th><th>Spec / size</th><th>Quantity rule</th><th class="n">Qty</th><th>Unit</th></tr></thead><tbody>
          ${its.map(i => `<tr class="click" data-it="${i.id}"><td class="small">${esc(i.category || '')}</td><td><b>${esc(i.description)}</b>${i.notes ? `<div class="small muted">${esc(i.notes)}</div>` : ''}</td><td class="small">${esc(i.spec || '')}</td>
            <td class="small muted">${i.qty_mode && i.qty_mode !== 'manual' ? `${fmt(i.rate, 2)} ${QTY_MODES[i.qty_mode].toLowerCase()}` : 'Entered'}${Number(i.allowance_pct) ? ` + ${fmt(i.allowance_pct)}%` : ''}</td>
            <td class="n"><b>${fmt(computeQty(i, a), 2)}</b></td><td>${esc(i.unit || '')}</td></tr>`).join('')}
        </tbody></table></div>` : `<div class="empty small">Nothing specified yet.</div>`}
      </section>`;
    }).join('')}
    <datalist id="dl-items">${suggestions.map(s => `<option value="${esc(s.description)}">${esc([s.spec, s.unit].filter(Boolean).join(' · '))}</option>`).join('')}</datalist>
  </div>`;

  root.querySelector('#flt').onchange = e => ctx.go(`#/p/${project.id}/spec${e.target.value === 'all' ? '' : '/' + e.target.value}`);
  root.querySelectorAll('[data-add]').forEach(b => b.onclick = async () => { if (await editItem(ctx, null, { areas, areaId: b.dataset.add === 'site' ? null : b.dataset.add, suggestions, count: items.length })) ctx.reload(); });
  root.querySelectorAll('[data-it]').forEach(r => r.onclick = async () => { if (await editItem(ctx, items.find(i => i.id === r.dataset.it), { areas, suggestions })) ctx.reload(); });
  root.querySelectorAll('[data-sug]').forEach(b => b.onclick = () => suggest(ctx, areas.find(a => a.id === b.dataset.sug), byArea[b.dataset.sug] || [], items.length));
}

export async function editItem(ctx, item, { areas, areaId = null, suggestions = [], count = 0 }) {
  const { store, project } = ctx;
  const cur = item || { area_id: areaId, category: 'Plants', unit: 'each', qty_mode: areaId ? 'per_m2' : 'manual', allowance_pct: 0 };
  const areaOf = id => areas.find(a => a.id === id);
  const body = `
    <label class="f">Area<select name="area_id"><option value="">Site-wide (not tied to an area)</option>${areas.map(a => `<option value="${a.id}" ${cur.area_id === a.id ? 'selected' : ''}>${esc(a.code || '')} ${esc(a.name || a.type || '')} · ${measureText(a)}</option>`).join('')}</select></label>
    <div class="grid2"><label class="f">Category<select name="category">${CATEGORIES.map(c => `<option ${cur.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="f">Unit<select name="unit">${UNITS.map(u => `<option ${cur.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label></div>
    <label class="f">Item<input name="description" list="dl-items" required value="${esc(cur.description)}" placeholder="e.g. Blue Plumbago, Kikuyu instant lawn, 110mm drainage pipe"></label>
    <label class="f">Spec / size / botanical name<input name="spec" value="${esc(cur.spec)}" placeholder="e.g. Plumbago auriculata, 4L bag"></label>
    <div class="dims">
      <label class="f">Quantity<select name="qty_mode">${Object.entries(QTY_MODES).map(([k, l]) => `<option value="${k}" ${cur.qty_mode === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="grid2"><label class="f" data-show="manual">Quantity<input name="qty" inputmode="decimal" value="${cur.qty ?? ''}"></label>
        <label class="f" data-show="rate"><span id="rate-l">Rate</span><input name="rate" inputmode="decimal" value="${cur.rate ?? ''}" placeholder="e.g. 4 plants per m²"></label>
        <label class="f">Allowance %<input name="allowance_pct" inputmode="decimal" value="${cur.allowance_pct ?? 0}" placeholder="e.g. 10 for mortality"></label></div>
      <div class="result" id="qres"></div></div>
    <label class="f">Notes<textarea name="notes" placeholder="Spacing, planting notes, supplier preference…">${esc(cur.notes)}</textarea></label>`;
  const calc = w => {
    const f = formData(w);
    const it = { ...f, qty: num(f.qty), rate: num(f.rate), allowance_pct: num(f.allowance_pct) };
    const a = areaOf(f.area_id);
    const manual = f.qty_mode === 'manual';
    w.querySelector('[data-show=manual]').hidden = !manual;
    w.querySelector('[data-show=rate]').hidden = manual;
    w.querySelector('#rate-l').textContent = { per_m2: `${f.unit} per m²`, per_m: `${f.unit} per metre`, per_no: `${f.unit} per point` }[f.qty_mode] || 'Rate';
    let note = '';
    if (!manual && !a) note = '<span class="flag">Pick an area for a rate-based quantity.</span>';
    else if (!manual) { const m = areaMeasures(a); note = `<span class="small muted">Area: ${f.qty_mode === 'per_m2' ? fmt(m.area, 2) + ' m²' : f.qty_mode === 'per_m' ? fmt(m.length || m.perimeter, 2) + ' m' : fmt(m.count) + ' no.'} · </span>`; }
    w.querySelector('#qres').innerHTML = `${note}Quantity: <b>${fmt(computeQty(it, a), 2)} ${esc(f.unit)}</b>`;
  };
  const v = await dialog({
    title: item ? 'Edit spec line' : 'Add spec line', wide: true, body,
    onOpen: w => { w.querySelectorAll('input,select').forEach(el => el.addEventListener('input', () => calc(w))); calc(w);
      w.querySelector('[name=description]').addEventListener('change', e => { const s = suggestions.find(x => x.description === e.target.value); if (s) { if (s.spec) w.querySelector('[name=spec]').value = s.spec; if (s.unit) w.querySelector('[name=unit]').value = s.unit; if (s.category) w.querySelector('[name=category]').value = s.category; calc(w); } }); },
    buttons: [...(item ? [{ label: 'Delete', danger: true, value: 'delete' }] : []), { label: 'Cancel', value: null }, { label: item ? 'Save' : 'Add', primary: true, value: w => formData(w), validate: w => !!w.querySelector('[name=description]').value.trim() }],
  });
  if (!v) return null;
  if (v === 'delete') { if (await confirmDlg('Delete spec line?', item.description)) { await store.remove('spec_items', item.id); return 'deleted'; } return null; }
  const row = {
    project_id: project.id, area_id: v.area_id || null, category: v.category, description: v.description.trim(), spec: v.spec.trim() || null, unit: v.unit,
    qty_mode: v.qty_mode, rate: num(v.rate), qty: num(v.qty), allowance_pct: num(v.allowance_pct) || 0, notes: v.notes || null,
  };
  row.item_key = itemKey(row.description, row.spec, row.unit);
  if (row.qty_mode !== 'manual' && !row.area_id) row.qty_mode = 'manual';
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
        <td class="small">${it.qty_mode === 'manual' ? fmt(it.qty, 2) : `${fmt(it.rate, 2)} ${QTY_MODES[it.qty_mode] ? QTY_MODES[it.qty_mode].toLowerCase() : ''}`}</td><td>${esc(it.unit || '')}</td></tr>`).join('')}
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
