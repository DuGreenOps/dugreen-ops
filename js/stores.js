// Central Stores (run by Procurement): stock sheet with ID numbers, issue vouchers to sites and people that the
// supervisor confirms on site, returns, goods received, and the stock ledger everything else reads from.
//
// Quantities: bulk (untagged) stock is a ledger of moves between locations ('store', 'transit', 'project:<id>',
// 'person:<id>', 'supplier', 'out'). Items with ID numbers are tracked one by one in `assets`.
import { esc, fmt, money, dialog, formData, toast, confirmDlg, num, today, fmtDate, uid, groupBy, csvCell, downloadFile, copyText, canStores, STOCK_CATS, UNITS, MOTORISED, TOOL_LIST } from './util.js';
import { captureSignature } from './sign.js';
import { head, open } from './docs.js';
import * as Equip from './equipment.js';

export const ITEM_KINDS = { tool: 'Tool (returnable)', machine: 'Machine / motorised', ppe: 'PPE', consumable: 'Consumable', fuel: 'Fuel / oil', material: 'Material' };
export const ASSET_STATUS = { store: 'In store', transit: 'In transit', site: 'On site', person: 'With person', repair: 'In repair', lost: 'Lost / stolen', written_off: 'Written off' };
export const VOUCHER_STATUS = { issued: 'Issued – awaiting receipt', received: 'Received', part: 'Received short', returned: 'Return – awaiting stores', closed: 'Returned to stores', cancelled: 'Cancelled' };
const vPill = s => `<span class="pill ${{ issued: 'warn', returned: 'warn', received: 'ok', closed: 'ok', part: 'bad', cancelled: 'mute' }[s] || 'mute'}">${esc(VOUCHER_STATUS[s] || s)}</span>`;
export const aPill = s => `<span class="pill ${{ store: 'ok', site: 'info', person: 'info', transit: 'warn', repair: 'warn', lost: 'bad', written_off: 'mute' }[s] || 'mute'}">${esc(ASSET_STATUS[s] || s)}</span>`;
const returnable = it => ['tool', 'machine'].includes(it?.kind);

// ----------------------------------------------------------------- data
export async function loadStores(store) {
  const [items, assets, moves, vouchers, people, projects, issues, services] = await Promise.all([
    store.list('stock_items', {}, 'name'), store.list('assets', {}, 'tag_no'), store.list('stock_moves', {}, 'move_date'), store.list('store_vouchers', {}, 'created_at'),
    store.list('staff', {}, 'name'), store.list('projects', {}, 'name'), store.list('equipment_issues', {}, 'created_at'), store.list('services', {}, 'service_date')]);
  const S = { items, assets, moves, vouchers, people, projects, issues, services,
    itemBy: Object.fromEntries(items.map(i => [i.id, i])), assetBy: Object.fromEntries(assets.map(a => [a.id, a])),
    personBy: Object.fromEntries(people.map(p => [p.id, p])), projBy: Object.fromEntries(projects.map(p => [p.id, p])) };
  return S;
}
// Bulk quantity of an item at a location (untagged stock only).
export function qtyAt(S, itemId, loc) {
  let q = 0; for (const m of S.moves) { if (m.item_id !== itemId || m.asset_id) continue; if (m.to_loc === loc) q += Number(m.qty) || 0; if (m.from_loc === loc) q -= Number(m.qty) || 0; }
  return Math.round(q * 1000) / 1000;
}
export const locOf = a => a.status === 'store' ? 'store' : a.status === 'transit' ? 'transit' : a.project_id ? 'project:' + a.project_id : a.person_id ? 'person:' + a.person_id : a.status;
export function locName(S, loc) {
  if (!loc) return '';
  if (loc === 'store') return 'Central Stores'; if (loc === 'transit') return 'In transit';
  const [k, id] = loc.split(':');
  return k === 'project' ? (S.projBy[id]?.name || 'Site') : k === 'person' ? (S.personBy[id]?.name || 'Person') : loc;
}
// Everything held at a site or by a person: bulk quantities + ID-numbered items.
export function holdings(S, loc) {
  const out = [];
  for (const it of S.items) {
    const q = qtyAt(S, it.id, loc), as = S.assets.filter(a => a.item_id === it.id && locOf(a) === loc && !['lost', 'written_off'].includes(a.status));
    if (q > 0.0001 || as.length) out.push({ item: it, qty: q, assets: as, total: q + as.length });
  }
  return out;
}
export function itemTotals(S, it) {
  const tagged = S.assets.filter(a => a.item_id === it.id);
  const inStore = qtyAt(S, it.id, 'store') + tagged.filter(a => a.status === 'store').length;
  const transit = qtyAt(S, it.id, 'transit') + tagged.filter(a => a.status === 'transit').length;
  let out = 0; const locs = new Set(); for (const m of S.moves) if (m.item_id === it.id && !m.asset_id) { if (/^(project|person):/.test(m.to_loc)) locs.add(m.to_loc); }
  for (const l of locs) out += Math.max(0, qtyAt(S, it.id, l));
  out += tagged.filter(a => ['site', 'person'].includes(a.status)).length;
  const repair = tagged.filter(a => a.status === 'repair').length;
  return { inStore, transit, out, repair, tagged: tagged.length, low: it.min_qty != null && inStore < Number(it.min_qty) };
}
async function nextNo(store, prefix) {
  const yr = new Date().getFullYear(), pre = `${prefix}-${yr}-`;
  const all = await store.list('store_vouchers', {}, null);
  const n = all.map(v => String(v.number || '')).filter(s => s.startsWith(pre)).map(s => parseInt(s.slice(pre.length), 10) || 0).reduce((a, b) => Math.max(a, b), 0);
  return pre + String(n + 1).padStart(3, '0');
}
const move = (store, m, me) => store.insert('stock_moves', { move_date: today(), by_name: me?.full_name || me?.email || null, ...m });

// ------------------------------------------------------------ page shell
const TABS = [['stock', 'Stock sheet'], ['ids', 'ID-numbered items'], ['vouchers', 'Issues & returns'], ['care', 'Damage & repairs'], ['service', 'Maintenance'], ['stocktake', 'Stock takes'], ['inspect', 'Inspections']];
export async function render(app, ctx, rest = []) {
  const { store, me } = ctx;
  const tab = rest[0] || 'stock';
  const S = await loadStores(store);
  const can = canStores(me);
  const pendingIn = S.vouchers.filter(v => v.status === 'returned').length, low = S.items.filter(i => i.active !== false && itemTotals(S, i).low).length;
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Procurement</div><h1>Central Stores</h1>
      <p class="small muted" style="margin:4px 0 0">Everything Du Green owns or keeps in stock, where it is, and who has it. ${can ? '' : 'Procurement manages stores; you can view, report damage and do inspections.'}</p></div>
      ${can ? '<div class="row"><button class="btn" id="grv">Receive stock</button><button class="btn primary" id="iss">Issue from stores</button></div>' : ''}</div>
    ${low ? `<div class="note warn"><b>${low}</b> item${low === 1 ? ' is' : 's are'} below the minimum level.</div>` : ''}
    <nav class="subtabs" style="flex-wrap:wrap">${TABS.map(([k, l]) => `<a href="#/stores/${k}" class="${tab === k ? 'on' : ''}">${l}${k === 'vouchers' && pendingIn ? ` (${pendingIn})` : k === 'care' && S.issues.filter(i => !['repaired', 'written_off', 'closed'].includes(i.status)).length ? ` (${S.issues.filter(i => !['repaired', 'written_off', 'closed'].includes(i.status)).length})` : ''}</a>`).join('')}</nav>
    <div id="sv"></div></div>`;
  app.querySelector('#iss')?.addEventListener('click', async () => { if (await issueDialog(ctx, S, {})) ctx.reload(); });
  app.querySelector('#grv')?.addEventListener('click', async () => { if (await receiveStockDialog(ctx, S)) ctx.reload(); });
  const el = app.querySelector('#sv');
  if (tab === 'ids') return assetsView(el, ctx, S);
  if (tab === 'vouchers') return vouchersView(el, ctx, S);
  if (tab === 'care') return Equip.issuesView(el, ctx, S);
  if (tab === 'service') return Equip.serviceView(el, ctx, S);
  if (tab === 'stocktake') return Equip.stocktakeView(el, ctx, S, rest[1]);
  if (tab === 'inspect') return Equip.inspectView(el, ctx, S, rest[1]);
  return stockView(el, ctx, S);
}

// -------------------------------------------------------------- stock sheet
function stockView(el, ctx, S) {
  const { store, me } = ctx, can = canStores(me);
  let cat = 'all', q = '';
  const draw = () => {
    const list = S.items.filter(i => i.active !== false && (cat === 'all' || i.category === cat) && (!q || `${i.code} ${i.name} ${i.category}`.toLowerCase().includes(q)));
    const rows = list.map(i => ({ i, t: itemTotals(S, i) }));
    const value = rows.reduce((t, r) => t + (Number(r.i.unit_cost) || 0) * (r.t.inStore + r.t.out + r.t.transit + r.t.repair), 0);
    el.innerHTML = `<div class="row" style="margin:10px 0;gap:6px;flex-wrap:wrap"><select id="cat" style="width:auto"><option value="all">All categories</option>${STOCK_CATS.map(c => `<option ${cat === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <input id="q" placeholder="Search code or name" value="${esc(q)}" style="max-width:220px"><span class="grow"></span>
        ${can ? '<button class="btn small" id="add">+ Item</button>' : ''}<button class="btn small" id="cp">Copy for Google Sheets</button><button class="btn small" id="csv">CSV</button><button class="btn small" id="pr">Print</button></div>
      <section class="card">${rows.length ? `<div class="tbl"><table class="sheet"><thead><tr><th>Code</th><th>Item</th><th>Category</th><th>Unit</th><th class="n">ID nos.</th><th class="n">In store</th><th class="n">On sites / people</th><th class="n">Repair</th><th class="n">Min</th><th class="n">Unit cost</th><th></th></tr></thead><tbody>
        ${rows.map(({ i, t }) => `<tr data-i="${i.id}"><td class="small">${esc(i.code || '')}</td><td><b class="click" data-open="${i.id}">${esc(i.name)}</b><div class="small muted">${esc(ITEM_KINDS[i.kind] || '')}${i.location ? ' · ' + esc(i.location) : ''}</div></td><td class="small">${esc(i.category || '')}</td><td class="small">${esc(i.unit || 'each')}</td>
          <td class="n">${t.tagged || '–'}</td><td class="n" style="${t.low ? 'color:var(--bad);font-weight:700' : ''}">${fmt(t.inStore, 2)}${t.transit ? `<div class="small muted">+${fmt(t.transit)} in transit</div>` : ''}</td><td class="n">${fmt(t.out, 2)}</td><td class="n">${t.repair || ''}</td>
          <td class="n">${can ? `<input class="num" style="width:60px" data-f="min_qty" inputmode="decimal" value="${i.min_qty ?? ''}">` : (i.min_qty ?? '')}</td><td class="n">${can ? `<input class="num" style="width:80px" data-f="unit_cost" inputmode="decimal" value="${i.unit_cost ?? ''}">` : fmt(i.unit_cost, 2)}</td>
          <td class="n"><button class="btn small" data-open="${i.id}">Open</button></td></tr>`).join('')}</tbody></table></div>
        <div class="small muted" style="padding:10px 14px">${rows.length} items · stock value at cost ${money(value, 0)}</div>`
      : `<div class="empty"><b>No stock items yet</b>${can ? 'Add the tools, machines, PPE, fuel and materials you keep. Give tools an ID number where you can (e.g. SP-001 painted on a spade).' : 'Procurement adds the items kept in stores.'}</div>`}</section>`;
    el.querySelector('#cat').onchange = e => { cat = e.target.value; draw(); };
    const qi = el.querySelector('#q'); qi.oninput = () => { q = qi.value.toLowerCase(); const p = qi.selectionStart; draw(); const n = el.querySelector('#q'); n.focus(); n.setSelectionRange(p, p); };
    el.querySelector('#add')?.addEventListener('click', async () => { if (await editItem(ctx, null)) ctx.reload(); });
    el.querySelectorAll('[data-open]').forEach(b => b.onclick = () => itemCard(ctx, S, S.itemBy[b.dataset.open]));
    if (can) el.querySelectorAll('tr[data-i] [data-f]').forEach(i => i.onchange = async () => { const id = i.closest('tr').dataset.i; Object.assign(S.itemBy[id], await store.update('stock_items', id, { [i.dataset.f]: num(i.value) })); toast('Saved'); draw(); });
    const table = () => [['Code', 'Item', 'Category', 'Kind', 'Unit', 'ID numbers', 'In store', 'In transit', 'On sites / people', 'In repair', 'Min level', 'Unit cost (E)', 'Below min'],
      ...rows.map(({ i, t }) => [i.code || '', i.name, i.category || '', ITEM_KINDS[i.kind] || '', i.unit || 'each', S.assets.filter(a => a.item_id === i.id).map(a => a.tag_no).join(' '), t.inStore, t.transit, t.out, t.repair, i.min_qty ?? '', i.unit_cost ?? '', t.low ? 'YES' : ''])];
    el.querySelector('#cp').onclick = async () => (await copyText(table().map(r => r.join('\t')).join('\n'))) ? toast('Copied – paste into Google Sheets') : toast('Copy failed');
    el.querySelector('#csv').onclick = () => downloadFile(`DuGreen_stores_${today()}.csv`, '﻿' + table().map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv');
    el.querySelector('#pr').onclick = () => open(`${head('Stores Stock Sheet', `<div style="font-size:13px">${fmtDate(today())}</div>`)}<table><thead><tr>${table()[0].slice(0, 11).map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${table().slice(1).map(r => `<tr>${r.slice(0, 11).map((c, k) => `<td${k > 5 ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`, 'Stock sheet');
  };
  draw();
}

export async function editItem(ctx, it) {
  const { store } = ctx;
  const v = await dialog({
    title: it ? it.name : 'New stock item', sticky: true,
    body: `<div class="grid2"><label class="f">Item name<input name="name" list="dl-tools" required value="${esc(it?.name)}"></label><label class="f">Code<input name="code" value="${esc(it?.code)}" placeholder="e.g. SPD"></label></div>
      <datalist id="dl-tools">${TOOL_LIST.map(t => `<option>${esc(t)}</option>`).join('')}</datalist>
      <div class="grid3"><label class="f">Category<select name="category">${STOCK_CATS.map(c => `<option ${it?.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label class="f">Kind<select name="kind">${Object.entries(ITEM_KINDS).map(([k, l]) => `<option value="${k}" ${it?.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="f">Unit<select name="unit">${['each', 'pair', 'set', 'L', 'kg', 'bag', 'm', 'roll', 'box'].map(u => `<option ${(it?.unit || 'each') === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label></div>
      <div class="grid3"><label class="f">Minimum level<input name="min_qty" inputmode="decimal" value="${it?.min_qty ?? ''}"></label><label class="f">Unit cost (E)<input name="unit_cost" inputmode="decimal" value="${it?.unit_cost ?? ''}"></label><label class="f">Bin / shelf<input name="location" value="${esc(it?.location)}"></label></div>
      <div class="dims" data-m><b style="font-family:var(--display)">Servicing</b> <span class="small muted">for motorised machines</span>
        <div class="grid2"><label class="f">Service every (hours)<input name="service_hours" inputmode="decimal" value="${it?.service_hours ?? ''}" placeholder="e.g. 50"></label><label class="f">or every (days)<input name="service_days" inputmode="numeric" value="${it?.service_days ?? ''}" placeholder="e.g. 90"></label></div></div>
      <label class="f">Notes<input name="notes" value="${esc(it?.notes)}"></label>
      ${it ? '' : '<p class="small muted">After saving, add ID numbers for each tagged tool or machine, or receive a bulk quantity into stores.</p>'}`,
    onOpen: w => { const k = w.querySelector('[name=kind]'), n = w.querySelector('[name=name]'), m = w.querySelector('[data-m]'); const sync = () => { m.hidden = k.value !== 'machine'; }; k.onchange = sync; n.onchange = () => { if (MOTORISED.includes(n.value)) { k.value = 'machine'; w.querySelector('[name=category]').value = /TLB|truck|Bakkie|Tractor|cart/i.test(n.value) ? 'Vehicles & plant' : 'Power tools & machines'; } else if (TOOL_LIST.includes(n.value)) { k.value = 'tool'; w.querySelector('[name=category]').value = 'Hand tools'; } sync(); }; sync(); },
    buttons: [...(it ? [{ label: 'Remove', danger: true, value: 'delete' }] : []), { label: 'Cancel', value: null }, { label: 'Save', primary: true, value: w => formData(w), validate: w => !!w.querySelector('[name=name]').value.trim() }],
  });
  if (!v) return null;
  if (v === 'delete') { if (await confirmDlg('Remove this item?', 'It is hidden from the stock sheet; its history is kept.', 'Remove')) { await store.update('stock_items', it.id, { active: false }); return 'deleted'; } return null; }
  const row = { name: v.name.trim(), code: v.code || null, category: v.category, kind: v.kind, unit: v.unit, min_qty: num(v.min_qty), unit_cost: num(v.unit_cost), location: v.location || null, service_hours: num(v.service_hours), service_days: num(v.service_days), notes: v.notes || null, active: true };
  const out = it ? await store.update('stock_items', it.id, row) : await store.insert('stock_items', row);
  toast('Saved'); return out;
}

// One item: totals, where each ID number is, history, add ID numbers.
async function itemCard(ctx, S, it) {
  const { store, me } = ctx, can = canStores(me);
  const t = itemTotals(S, it), tags = S.assets.filter(a => a.item_id === it.id);
  const locs = {}; for (const m of S.moves.filter(m => m.item_id === it.id && !m.asset_id)) for (const l of [m.to_loc, m.from_loc]) if (/^(project|person):/.test(l)) locs[l] = qtyAt(S, it.id, l);
  const hist = S.moves.filter(m => m.item_id === it.id).slice(-25).reverse();
  const v = await dialog({
    title: `${it.code ? it.code + ' · ' : ''}${it.name}`, wide: true,
    body: `<div class="kpis"><div class="kpi"><div class="k">In store</div><div class="v">${fmt(t.inStore, 2)}</div></div><div class="kpi"><div class="k">Out</div><div class="v">${fmt(t.out, 2)}</div></div><div class="kpi"><div class="k">In transit</div><div class="v">${fmt(t.transit, 2)}</div></div><div class="kpi"><div class="k">In repair</div><div class="v">${t.repair}</div></div></div>
      ${Object.keys(locs).length ? `<h3 style="font-size:15px;margin:10px 0 4px">Bulk quantities out</h3><div class="tbl"><table><tbody>${Object.entries(locs).filter(([, q]) => q > 0).map(([l, q]) => `<tr><td>${esc(locName(S, l))}</td><td class="n">${fmt(q, 2)} ${esc(it.unit || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <h3 style="font-size:15px;margin:10px 0 4px">ID-numbered (${tags.length})</h3>
      ${tags.length ? `<div class="tbl"><table><thead><tr><th>ID no.</th><th>Make / serial</th><th>Where</th><th>Condition</th><th>Status</th></tr></thead><tbody>${tags.map(a => `<tr class="click" data-a="${a.id}"><td><b>${esc(a.tag_no)}</b></td><td class="small">${esc([a.make_model, a.serial].filter(Boolean).join(' · '))}</td><td class="small">${esc(locName(S, locOf(a)))}</td><td class="small">${esc(a.condition || '')}</td><td>${aPill(a.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">None. Items without an ID number are counted as a bulk quantity.</p>'}
      <h3 style="font-size:15px;margin:10px 0 4px">Recent movements</h3>
      ${hist.length ? `<div class="tbl"><table><tbody>${hist.map(m => `<tr><td class="small">${fmtDate(m.move_date)}</td><td class="small">${esc(m.type)}</td><td class="small">${m.asset_id ? esc(S.assetBy[m.asset_id]?.tag_no || '') : fmt(m.qty, 2)}</td><td class="small">${esc(locName(S, m.from_loc))} → ${esc(locName(S, m.to_loc))}</td><td class="small muted">${esc(m.ref || m.note || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">No movements yet.</p>'}`,
    onOpen: w => w.querySelectorAll('[data-a]').forEach(r => r.onclick = async () => { w.querySelector('[data-x]').click(); if (await assetCard(ctx, S, S.assetBy[r.dataset.a])) ctx.reload(); }),
    buttons: [...(can ? [{ label: 'Edit item', value: 'edit' }, { label: 'Stock adjustment', value: 'adj' }, { label: '+ ID numbers', primary: true, value: 'tags' }] : [{ label: 'Close', value: null }])],
  });
  if (v === 'edit' && await editItem(ctx, it)) ctx.reload();
  if (v === 'tags' && await addTags(ctx, S, it)) ctx.reload();
  if (v === 'adj' && await adjustDialog(ctx, S, it)) ctx.reload();
}

async function addTags(ctx, S, it) {
  const { store, me } = ctx;
  const n = S.assets.filter(a => a.item_id === it.id).length;
  const pre = (it.code || it.name.replace(/[^A-Za-z]/g, '').slice(0, 3)).toUpperCase();
  const v = await dialog({
    title: `Add ID numbers – ${it.name}`, sticky: true,
    body: `<p class="small muted">One record per physical item. Paint or engrave the ID number on the item. Use “Several” to number a batch, e.g. ${esc(pre)}-001 to ${esc(pre)}-010.</p>
      <div class="grid3"><label class="f">Prefix<input name="pre" value="${esc(pre)}-"></label><label class="f">From no.<input name="from" inputmode="numeric" value="${n + 1}"></label><label class="f">How many<input name="count" inputmode="numeric" value="1"></label></div>
      <label class="f">Or type ID numbers (one per line)<textarea name="list" rows="3" placeholder="leave blank to use the numbering above"></textarea></label>
      <div class="grid3"><label class="f">Make / model<input name="make_model"></label><label class="f">Purchase date<input name="purchase_date" type="date"></label><label class="f">Cost each (E)<input name="cost" inputmode="decimal" value="${it.unit_cost ?? ''}"></label></div>
      <label class="chk"><input type="checkbox" name="convert" checked> These are already counted in the bulk store quantity – move them out of the bulk count</label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Add', primary: true, value: w => formData(w) }],
  });
  if (!v) return null;
  let tags = (v.list || '').split(/\n|,/).map(s => s.trim()).filter(Boolean);
  if (!tags.length) { const f = num(v.from) || 1, c = Math.max(1, num(v.count) || 1); tags = Array.from({ length: c }, (_, i) => `${v.pre}${String(f + i).padStart(3, '0')}`); }
  const dup = tags.filter(t => S.assets.some(a => a.tag_no === t)); if (dup.length) { toast(`Already used: ${dup.join(', ')}`); return null; }
  await store.insert('assets', tags.map(t => ({ item_id: it.id, tag_no: t, make_model: v.make_model || null, purchase_date: v.purchase_date || null, cost: num(v.cost), status: 'store', condition: 'Good', hours: 0 })));
  const bulk = qtyAt(S, it.id, 'store');
  if (v.convert && bulk > 0) await move(store, { item_id: it.id, qty: Math.min(bulk, tags.length), type: 'adjust', from_loc: 'store', to_loc: 'out', note: 'Moved to ID-numbered records' }, me);
  toast(`${tags.length} ID number${tags.length === 1 ? '' : 's'} added`); return true;
}

async function adjustDialog(ctx, S, it) {
  const { store, me } = ctx;
  const cur = qtyAt(S, it.id, 'store');
  const v = await dialog({ title: `Adjust stock – ${it.name}`, body: `<p>Bulk quantity in store now: <b>${fmt(cur, 2)} ${esc(it.unit || '')}</b></p><div class="grid2"><label class="f">Correct quantity<input name="q" inputmode="decimal" value="${cur}"></label><label class="f">Reason<select name="r"><option>Count correction</option><option>Damaged / expired</option><option>Lost</option><option>Opening balance</option></select></label></div><label class="f">Note<input name="n"></label>`, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, value: w => formData(w) }] });
  if (!v) return null;
  const d = (num(v.q) ?? cur) - cur; if (!d) return null;
  await move(store, { item_id: it.id, qty: Math.abs(d), type: 'adjust', from_loc: d > 0 ? 'supplier' : 'store', to_loc: d > 0 ? 'store' : 'out', note: `${v.r}${v.n ? ': ' + v.n : ''}` }, me);
  toast('Stock adjusted'); return true;
}

// ------------------------------------------------------- receive stock (GRV)
export async function receiveStockDialog(ctx, S, pre = {}) {
  const { store, me } = ctx;
  let lines = pre.lines?.length ? pre.lines : [{ item_id: '', qty: '', cost: '' }];
  const opts = v => `<option value="">Choose item…</option>${S.items.filter(i => i.active !== false).map(i => `<option value="${i.id}" ${v === i.id ? 'selected' : ''}>${esc(i.name)}${i.code ? ' (' + esc(i.code) + ')' : ''}</option>`).join('')}`;
  const body = () => `<div class="grid2"><label class="f">From supplier<input name="from" value="${esc(pre.from || '')}" placeholder="Supplier name"></label><label class="f">Delivery note / invoice no.<input name="ref" value="${esc(pre.ref || '')}"></label></div>
    <div class="tbl"><table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Unit cost (E)</th></tr></thead><tbody id="gl">${lines.map((l, i) => `<tr><td><select data-g="${i}" data-k="item_id">${opts(l.item_id)}</select></td><td class="n"><input class="num" style="width:80px" data-g="${i}" data-k="qty" inputmode="decimal" value="${l.qty ?? ''}"></td><td class="n"><input class="num" style="width:90px" data-g="${i}" data-k="cost" inputmode="decimal" value="${l.cost ?? ''}"></td></tr>`).join('')}</tbody></table></div>
    <div class="row"><button class="btn small" type="button" id="gadd">+ Line</button><button class="btn small" type="button" id="gnew">+ New item</button></div>
    <p class="small muted">Items with ID numbers: receive them here, then add their ID numbers on the item.</p>`;
  const read = w => { w.querySelectorAll('[data-g]').forEach(i => { lines[+i.dataset.g][i.dataset.k] = i.value; }); };
  const v = await dialog({
    title: 'Receive stock into Central Stores', wide: true, sticky: true, body: body(),
    onOpen: w => { const wire = () => { w.querySelector('#gadd').onclick = () => { read(w); lines.push({ item_id: '', qty: '', cost: '' }); w.querySelector('.dlg-body').innerHTML = body(); wire(); }; w.querySelector('#gnew').onclick = async () => { read(w); const it = await editItem(ctx, null); if (it && it !== 'deleted') { S.items.push(it); S.itemBy[it.id] = it; lines.push({ item_id: it.id, qty: '', cost: it.unit_cost ?? '' }); } w.querySelector('.dlg-body').innerHTML = body(); wire(); }; }; wire(); },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Receive', primary: true, value: w => { read(w); return formData(w); } }],
  });
  if (!v) return null;
  const good = lines.filter(l => l.item_id && num(l.qty) > 0);
  if (!good.length) return null;
  const vch = await store.insert('store_vouchers', { kind: 'receive', number: await nextNo(store, 'GRV'), voucher_date: today(), to_loc: 'store', lines: good.map(l => ({ item_id: l.item_id, name: S.itemBy[l.item_id]?.name, unit: S.itemBy[l.item_id]?.unit, qty: num(l.qty), cost: num(l.cost) })), status: 'received', issued_by: me?.full_name || null, ref: v.ref || null, supplier: v.from || null, po_id: pre.po_id || null });
  for (const l of good) { await move(store, { item_id: l.item_id, qty: num(l.qty), type: 'receive', from_loc: 'supplier', to_loc: 'store', voucher_id: vch.id, ref: [v.from, v.ref].filter(Boolean).join(' · ') }, me); if (num(l.cost) != null) await store.update('stock_items', l.item_id, { unit_cost: num(l.cost) }); }
  toast(`${vch.number} received into stores`); return vch;
}

// -------------------------------------------------------------- issue voucher
// pre: { projectId, personId, lines:[{item_id, qty, name}], requestId }
export async function issueDialog(ctx, S, pre) {
  const { store, me } = ctx;
  let to = pre.personId ? 'person:' + pre.personId : pre.projectId ? 'project:' + pre.projectId : '';
  let lines = (pre.lines || []).map(l => ({ item_id: l.item_id || '', asset_ids: [], qty: l.qty ?? 1, name: l.name })); if (!lines.length) lines = [{ item_id: '', asset_ids: [], qty: 1 }];
  const live = S.projects.filter(p => p.status !== 'complete');
  const itemOpts = v => `<option value="">Choose item…</option>${STOCK_CATS.map(c => { const its = S.items.filter(i => i.active !== false && i.category === c); return its.length ? `<optgroup label="${esc(c)}">${its.map(i => { const t = itemTotals(S, i); return `<option value="${i.id}" ${v === i.id ? 'selected' : ''}>${esc(i.name)} – ${fmt(t.inStore)} in store</option>`; }).join('')}</optgroup>` : ''; }).join('')}`;
  const body = () => `<label class="f">Issue to<select name="to"><option value="">Choose a site or person…</option><optgroup label="Sites">${live.map(p => `<option value="project:${p.id}" ${to === 'project:' + p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>
      <optgroup label="People (PPE, personal tools)">${S.people.filter(p => p.active !== false && p.kind !== 'subcontractor').map(p => `<option value="person:${p.id}" ${to === 'person:' + p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup></select></label>
    ${pre.requestNote ? `<p class="small muted">For request: ${esc(pre.requestNote)}</p>` : ''}
    <div class="stack" id="il" style="gap:8px">${lines.map((l, i) => { const it = S.itemBy[l.item_id]; const free = it ? S.assets.filter(a => a.item_id === it.id && a.status === 'store') : []; const bulk = it ? qtyAt(S, it.id, 'store') : 0;
      return `<div class="dims"><div class="grid3"><label class="f span2">Item${l.name && !l.item_id ? ` <span class="small flag">requested: ${esc(l.name)}</span>` : ''}<select data-il="${i}" data-k="item_id">${itemOpts(l.item_id)}</select></label><label class="f">Bulk qty${it ? ` (${fmt(bulk)} available)` : ''}<input data-il="${i}" data-k="qty" inputmode="decimal" value="${free.length && !bulk ? 0 : l.qty ?? ''}"></label></div>
        ${free.length ? `<div class="small muted">ID numbers in store – tick the ones going out:</div><div class="row" style="gap:4px 12px">${free.map(a => `<label class="chk"><input type="checkbox" data-ia="${i}" value="${a.id}" ${l.asset_ids.includes(a.id) ? 'checked' : ''}> ${esc(a.tag_no)}</label>`).join('')}</div>` : ''}</div>`; }).join('')}</div>
    <button class="btn small" type="button" id="iadd">+ Item</button>
    <label class="f">Notes<input name="notes" value="${esc(pre.notes || '')}"></label>`;
  const read = w => { to = w.querySelector('[name=to]').value; w.querySelectorAll('[data-il]').forEach(i => { lines[+i.dataset.il][i.dataset.k] = i.dataset.k === 'qty' ? num(i.value) : i.value; }); lines.forEach((l, i) => { l.asset_ids = [...w.querySelectorAll(`[data-ia="${i}"]:checked`)].map(c => c.value); }); };
  const v = await dialog({
    title: 'Issue from Central Stores', wide: true, sticky: true, body: body(),
    onOpen: w => { const wire = () => { w.querySelector('#iadd').onclick = () => { read(w); lines.push({ item_id: '', asset_ids: [], qty: 1 }); w.querySelector('.dlg-body').innerHTML = body(); wire(); }; w.querySelectorAll('[data-k=item_id]').forEach(s => s.onchange = () => { read(w); w.querySelector('.dlg-body').innerHTML = body(); wire(); }); }; wire(); },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Issue', primary: true, value: w => { read(w); return { notes: w.querySelector('[name=notes]').value }; }, validate: w => { read(w); if (!to) { toast('Choose where it is going'); return false; } if (!lines.some(l => l.item_id && ((l.qty || 0) > 0 || l.asset_ids.length))) { toast('Add at least one item'); return false; } const over = lines.find(l => l.item_id && (l.qty || 0) > qtyAt(S, l.item_id, 'store') + 1e-9); if (over) { toast(`Not enough ${S.itemBy[over.item_id].name} in store`); return false; } return true; } }],
  });
  if (!v) return null;
  return await createIssue(ctx, S, { to, lines, notes: v.notes, requestId: pre.requestId });
}

export async function createIssue(ctx, S, { to, lines, notes, requestId }) {
  const { store, me } = ctx;
  const [k, id] = to.split(':');
  const out = [];
  for (const l of lines.filter(l => l.item_id)) {
    const it = S.itemBy[l.item_id];
    if ((l.qty || 0) > 0) out.push({ item_id: it.id, name: it.name, unit: it.unit || 'each', qty: Number(l.qty) });
    for (const aid of l.asset_ids || []) out.push({ item_id: it.id, asset_id: aid, name: it.name, tag: S.assetBy[aid]?.tag_no, unit: 'each', qty: 1 });
  }
  const vch = await store.insert('store_vouchers', { kind: 'issue', number: await nextNo(store, 'ISS'), voucher_date: today(), to_loc: to, project_id: k === 'project' ? id : null, person_id: k === 'person' ? id : null, lines: out, status: 'issued', issued_by: me?.full_name || me?.email || null, notes: notes || null, request_id: requestId || null });
  for (const l of out) {
    await move(store, { item_id: l.item_id, asset_id: l.asset_id || null, qty: l.qty, type: 'issue', from_loc: 'store', to_loc: 'transit', voucher_id: vch.id, ref: vch.number }, me);
    if (l.asset_id) await store.update('assets', l.asset_id, { status: 'transit', project_id: k === 'project' ? id : null, person_id: k === 'person' ? id : null });
  }
  toast(`${vch.number} issued – waiting for ${k === 'project' ? 'the site' : 'the person'} to confirm receipt`);
  return vch;
}

// Supervisor (or the person) confirms what arrived. Short quantities are flagged for Procurement.
export async function receiveVoucher(ctx, S, vch) {
  const { store, me } = ctx;
  const ret = vch.kind === 'return';
  const v = await dialog({
    title: `${ret ? 'Receive return' : 'Confirm receipt'} · ${vch.number}`, wide: true, sticky: true,
    body: `<p class="small muted">${ret ? `Returned from ${esc(locName(S, vch.from_loc))}` : `From Central Stores to ${esc(locName(S, vch.to_loc))}`} · ${fmtDate(vch.voucher_date)} · ${esc(vch.issued_by || '')}</p>
      <div class="tbl"><table><thead><tr><th>Item</th><th>ID no.</th><th class="n">Sent</th><th class="n">Received</th><th>Condition</th></tr></thead><tbody>${vch.lines.map((l, i) => `<tr><td>${esc(l.name)}</td><td>${esc(l.tag || '')}</td><td class="n">${fmt(l.qty, 2)} ${esc(l.unit || '')}</td>
        <td class="n">${l.asset_id ? `<input type="checkbox" data-rq="${i}" checked aria-label="Received">` : `<input class="num" style="width:80px" data-rq="${i}" inputmode="decimal" value="${l.qty}">`}</td>
        <td><select data-rc="${i}"><option>Good</option><option>Fair</option><option>Damaged</option></select></td></tr>`).join('')}</tbody></table></div>
      <label class="f">Received by<input name="by" value="${esc(me?.full_name || '')}"></label><label class="f">Note<input name="note" placeholder="e.g. 2 spades short, handle cracked"></label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Sign & confirm', primary: true, value: w => ({ q: [...w.querySelectorAll('[data-rq]')].map(i => i.type === 'checkbox' ? (i.checked ? 1 : 0) : num(i.value) ?? 0), c: [...w.querySelectorAll('[data-rc]')].map(s => s.value), by: w.querySelector('[name=by]').value, note: w.querySelector('[name=note]').value }) }],
  });
  if (!v) return null;
  const sig = await captureSignature('Signature on receipt', v.by); if (!sig) return null;
  const dest = ret ? 'store' : vch.to_loc;
  let short = false;
  const lines = vch.lines.map((l, i) => ({ ...l, qty_received: v.q[i], condition: v.c[i] }));
  for (const l of lines) {
    const got = Math.min(Number(l.qty_received) || 0, Number(l.qty));
    if (got > 0) await move(store, { item_id: l.item_id, asset_id: l.asset_id || null, qty: got, type: ret ? 'return' : 'receive_site', from_loc: 'transit', to_loc: dest, voucher_id: vch.id, ref: vch.number }, me);
    if (got < Number(l.qty)) { short = true; await move(store, { item_id: l.item_id, asset_id: l.asset_id || null, qty: Number(l.qty) - got, type: 'short', from_loc: 'transit', to_loc: 'out', voucher_id: vch.id, ref: vch.number, note: 'Not received: ' + (v.note || '') }, me); }
    if (l.asset_id) {
      const [k, id] = dest.split(':');
      await store.update('assets', l.asset_id, got ? { status: dest === 'store' ? 'store' : k === 'person' ? 'person' : 'site', project_id: k === 'project' ? id : null, person_id: k === 'person' ? id : null, condition: l.condition } : { status: 'lost' });
    }
    if (l.condition === 'Damaged') await store.insert('equipment_issues', { asset_id: l.asset_id || null, item_id: l.item_id, item_name: l.name, tag_no: l.tag || null, project_id: vch.project_id || null, kind: 'Damaged', description: `Damaged on ${ret ? 'return to stores' : 'delivery'} (${vch.number}). ${v.note || ''}`.trim(), reported_by: v.by, status: 'open', photos: [] });
  }
  await store.update('store_vouchers', vch.id, { lines, status: ret ? 'closed' : short ? 'part' : 'received', received_by: v.by, received_at: new Date().toISOString(), receive_sign: sig, receive_note: v.note || null });
  toast(short ? 'Received with items short – Procurement will follow up' : 'Receipt confirmed');
  return true;
}

// Site (or person) sends items back to stores. Stores confirms when they arrive.
export async function returnDialog(ctx, S, fromLoc) {
  const { store, me } = ctx;
  const H = holdings(S, fromLoc);
  if (!H.length) { toast('Nothing from stores is recorded here'); return null; }
  const v = await dialog({
    title: `Return to Central Stores – ${locName(S, fromLoc)}`, wide: true, sticky: true,
    body: `<div class="tbl"><table><thead><tr><th>Item</th><th class="n">Here</th><th>Return</th></tr></thead><tbody>${H.map((h, i) => `<tr><td><b>${esc(h.item.name)}</b></td><td class="n">${fmt(h.total)}</td><td>
      ${h.qty > 0 && h.item.kind !== 'fuel' ? `<input class="num" style="width:70px" data-rb="${i}" inputmode="decimal" placeholder="qty"> ` : ''}${h.assets.map(a => `<label class="chk"><input type="checkbox" data-ra="${a.id}" data-i="${i}"> ${esc(a.tag_no)}</label>`).join(' ')}</td></tr>`).join('')}</tbody></table></div>
      <label class="f">Note<input name="note" placeholder="e.g. job finished, mower not starting"></label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Send back', primary: true, value: w => ({ b: [...w.querySelectorAll('[data-rb]')].map(i => ({ i: +i.dataset.rb, q: num(i.value) })), a: [...w.querySelectorAll('[data-ra]:checked')].map(c => ({ i: +c.dataset.i, id: c.dataset.ra })), note: w.querySelector('[name=note]').value }) }],
  });
  if (!v) return null;
  const lines = [];
  for (const x of v.b) if (x.q > 0) { const h = H[x.i]; lines.push({ item_id: h.item.id, name: h.item.name, unit: h.item.unit, qty: Math.min(x.q, h.qty) }); }
  for (const x of v.a) { const a = S.assetBy[x.id]; lines.push({ item_id: a.item_id, asset_id: a.id, name: S.itemBy[a.item_id]?.name, tag: a.tag_no, unit: 'each', qty: 1 }); }
  if (!lines.length) return null;
  const [k, id] = fromLoc.split(':');
  const vch = await store.insert('store_vouchers', { kind: 'return', number: await nextNo(store, 'RET'), voucher_date: today(), from_loc: fromLoc, to_loc: 'store', project_id: k === 'project' ? id : null, person_id: k === 'person' ? id : null, lines, status: 'returned', issued_by: me?.full_name || null, notes: v.note || null });
  for (const l of lines) { await move(store, { item_id: l.item_id, asset_id: l.asset_id || null, qty: l.qty, type: 'return_out', from_loc: fromLoc, to_loc: 'transit', voucher_id: vch.id, ref: vch.number }, me); if (l.asset_id) await store.update('assets', l.asset_id, { status: 'transit' }); }
  toast(`${vch.number}: return on its way to stores`); return vch;
}

// ------------------------------------------------------------ vouchers view
function vouchersView(el, ctx, S) {
  const { me } = ctx;
  const list = [...S.vouchers].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const row = v => `<tr class="click" data-v="${v.id}"><td><b>${esc(v.number)}</b><div class="small muted">${fmtDate(v.voucher_date)}</div></td><td class="small">${v.kind === 'receive' ? esc(v.supplier || 'Supplier') + ' → Stores' : v.kind === 'return' ? esc(locName(S, v.from_loc)) + ' → Stores' : 'Stores → ' + esc(locName(S, v.to_loc))}</td>
    <td class="small">${esc((v.lines || []).map(l => `${l.tag || fmt(l.qty) + ' ' + (l.unit || '')} ${l.name}`).slice(0, 4).join(', '))}${(v.lines || []).length > 4 ? '…' : ''}</td><td>${vPill(v.status)}</td></tr>`;
  const waiting = list.filter(v => v.kind === 'return' && v.status === 'returned'), inTransit = list.filter(v => v.kind === 'issue' && v.status === 'issued'), short = list.filter(v => v.status === 'part');
  el.innerHTML = `${waiting.length ? `<section class="card"><div class="hd"><h3>Returns waiting for stores</h3><span class="pill warn">${waiting.length}</span></div><div class="tbl"><table><tbody>${waiting.map(row).join('')}</tbody></table></div></section>` : ''}
    ${short.length ? `<section class="card"><div class="hd"><h3>Received short – follow up</h3><span class="pill bad">${short.length}</span></div><div class="tbl"><table><tbody>${short.map(row).join('')}</tbody></table></div></section>` : ''}
    ${inTransit.length ? `<section class="card"><div class="hd"><h3>Issued, not yet confirmed by site</h3><span class="pill warn">${inTransit.length}</span></div><div class="tbl"><table><tbody>${inTransit.map(row).join('')}</tbody></table></div></section>` : ''}
    <section class="card"><div class="hd"><h3>All vouchers</h3></div>${list.length ? `<div class="tbl"><table><thead><tr><th>No.</th><th>Movement</th><th>Items</th><th>Status</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>` : '<div class="empty small">No issues or returns yet.</div>'}</section>`;
  el.querySelectorAll('[data-v]').forEach(r => r.onclick = async () => { const v = S.vouchers.find(x => x.id === r.dataset.v); if (await voucherCard(ctx, S, v)) ctx.reload(); });
}

export async function voucherCard(ctx, S, v) {
  const { me } = ctx;
  const canReceive = (v.kind === 'issue' && v.status === 'issued') || (v.kind === 'return' && v.status === 'returned' && canStores(me));
  const r = await dialog({
    title: `${v.number}`, wide: true,
    body: `<div class="row">${vPill(v.status)}<span class="small muted">${esc(v.issued_by || '')} · ${fmtDate(v.voucher_date)}</span></div>
      <div class="tbl"><table><thead><tr><th>Item</th><th>ID no.</th><th class="n">Qty</th><th class="n">Received</th><th>Condition</th></tr></thead><tbody>${(v.lines || []).map(l => `<tr><td>${esc(l.name)}</td><td>${esc(l.tag || '')}</td><td class="n">${fmt(l.qty, 2)} ${esc(l.unit || '')}</td><td class="n">${l.qty_received != null ? fmt(l.qty_received, 2) : '–'}</td><td>${esc(l.condition || '')}</td></tr>`).join('')}</tbody></table></div>
      ${v.notes ? `<p class="small">${esc(v.notes)}</p>` : ''}${v.receive_note ? `<p class="small">Receipt note: ${esc(v.receive_note)}</p>` : ''}
      ${v.receive_sign ? `<div class="small muted">Received by ${esc(v.received_by || '')} ${v.received_at ? new Date(v.received_at).toLocaleString('en-GB') : ''}</div><img alt="Signature" src="${v.receive_sign}" style="height:60px;background:#fff;border:1px solid var(--line);border-radius:8px">` : ''}`,
    buttons: [{ label: 'Print', value: 'print' }, ...(canReceive ? [{ label: v.kind === 'return' ? 'Receive into stores' : 'Confirm receipt', primary: true, value: 'rec' }] : [{ label: 'Close', primary: true, value: null }])],
  });
  if (r === 'print') printVoucher(S, v);
  if (r === 'rec') return await receiveVoucher(ctx, S, v);
  return null;
}

export function printVoucher(S, v) {
  open(`${head({ issue: 'Stores Issue Voucher', return: 'Stores Return Voucher', receive: 'Goods Received Voucher' }[v.kind] || 'Stores Voucher', `<div style="font-size:13px">${esc(v.number)}</div>`)}
    <div class="meta"><div><b>Date:</b> ${fmtDate(v.voucher_date)}<br><b>From:</b> ${esc(v.kind === 'receive' ? v.supplier || 'Supplier' : v.kind === 'return' ? locName(S, v.from_loc) : 'Central Stores')}<br><b>To:</b> ${esc(v.kind === 'issue' ? locName(S, v.to_loc) : 'Central Stores')}</div><div><b>Issued by:</b> ${esc(v.issued_by || '')}<br><b>Status:</b> ${esc(VOUCHER_STATUS[v.status] || v.status)}${v.ref ? `<br><b>Ref:</b> ${esc(v.ref)}` : ''}</div></div>
    <table><thead><tr><th>#</th><th>Item</th><th>ID no.</th><th class="n">Qty</th><th>Unit</th><th class="n">Received</th><th>Condition</th></tr></thead><tbody>${(v.lines || []).map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.name)}</td><td>${esc(l.tag || '')}</td><td class="n">${fmt(l.qty, 2)}</td><td>${esc(l.unit || '')}</td><td class="n">${l.qty_received != null ? fmt(l.qty_received, 2) : ''}</td><td>${esc(l.condition || '')}</td></tr>`).join('')}</tbody></table>
    ${v.notes ? `<div class="box"><b>Notes</b><div>${esc(v.notes)}</div></div>` : ''}
    <div class="sig"><div>Issued by: ${esc(v.issued_by || '')}</div><div>${v.receive_sign ? `<img src="${v.receive_sign}" style="height:50px">` : ''}Received by: ${esc(v.received_by || '')}${v.received_at ? ' · ' + fmtDate(v.received_at) : ''}</div></div>`, v.number);
}

// ----------------------------------------------------------- ID-numbered items
function assetsView(el, ctx, S) {
  let f = 'all', q = '';
  const draw = () => {
    const list = S.assets.filter(a => (f === 'all' || a.status === f || (f === 'machines' && S.itemBy[a.item_id]?.kind === 'machine')) && (!q || `${a.tag_no} ${S.itemBy[a.item_id]?.name} ${a.make_model || ''} ${a.serial || ''}`.toLowerCase().includes(q)));
    el.innerHTML = `<div class="row" style="margin:10px 0;gap:6px;flex-wrap:wrap">${[['all', 'All'], ['machines', 'Machines'], ...Object.entries(ASSET_STATUS)].map(([k, l]) => `<button class="btn small ${f === k ? 'primary' : ''}" data-f="${k}">${l}</button>`).join('')}<input id="q" placeholder="Search ID no." value="${esc(q)}" style="max-width:180px;margin-left:auto"></div>
      <section class="card">${list.length ? `<div class="tbl"><table><thead><tr><th>ID no.</th><th>Item</th><th>Where / who</th><th>Condition</th><th class="n">Hours</th><th>Service</th><th>Status</th></tr></thead><tbody>
      ${list.map(a => { const it = S.itemBy[a.item_id], sd = Equip.serviceDue(S, a); return `<tr class="click" data-a="${a.id}"><td><b>${esc(a.tag_no)}</b></td><td>${esc(it?.name || '')}<div class="small muted">${esc(a.make_model || '')}</div></td><td class="small">${esc(locName(S, locOf(a)))}</td><td class="small">${esc(a.condition || '')}</td><td class="n">${it?.kind === 'machine' ? fmt(a.hours || 0, 1) : ''}</td><td>${sd ? Equip.duePill(sd) : ''}</td><td>${aPill(a.status)}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="empty"><b>No ID-numbered items</b>Open an item on the stock sheet and use “+ ID numbers”.</div>'}</section>`;
    el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { f = b.dataset.f; draw(); });
    const qi = el.querySelector('#q'); qi.oninput = () => { q = qi.value.toLowerCase(); const p = qi.selectionStart; draw(); const n = el.querySelector('#q'); n.focus(); n.setSelectionRange(p, p); };
    el.querySelectorAll('[data-a]').forEach(r => r.onclick = async () => { if (await assetCard(ctx, S, S.assetBy[r.dataset.a])) ctx.reload(); });
  };
  draw();
}

export async function assetCard(ctx, S, a) {
  const { store, me } = ctx, can = canStores(me);
  const it = S.itemBy[a.item_id];
  const iss = S.issues.filter(x => x.asset_id === a.id).reverse(), sv = S.services.filter(x => x.asset_id === a.id).reverse();
  const moves = S.moves.filter(m => m.asset_id === a.id).reverse().slice(0, 15);
  const sd = Equip.serviceDue(S, a);
  const v = await dialog({
    title: `${a.tag_no} · ${it?.name || ''}`, wide: true,
    body: `<div class="row">${aPill(a.status)}<span>${esc(locName(S, locOf(a)))}</span>${a.condition ? `<span class="small muted">Condition: ${esc(a.condition)}</span>` : ''}${sd ? Equip.duePill(sd) : ''}</div>
      <div class="grid3" style="margin-top:8px">
        <label class="f">Make / model<input name="make_model" value="${esc(a.make_model)}" ${can ? '' : 'disabled'}></label><label class="f">Serial no.<input name="serial" value="${esc(a.serial)}" ${can ? '' : 'disabled'}></label><label class="f">Condition<select name="condition" ${can ? '' : 'disabled'}>${['Good', 'Fair', 'Poor'].map(c => `<option ${a.condition === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        ${it?.kind === 'machine' ? `<label class="f">Hours meter<input name="hours" inputmode="decimal" value="${a.hours ?? 0}" ${can ? '' : 'disabled'}></label>` : ''}
        <label class="f">Purchase date<input type="date" name="purchase_date" value="${esc(a.purchase_date || '')}" ${can ? '' : 'disabled'}></label><label class="f">Cost (E)<input name="cost" inputmode="decimal" value="${a.cost ?? ''}" ${can ? '' : 'disabled'}></label></div>
      <h3 style="font-size:15px;margin:12px 0 4px">Damage & repairs</h3>${iss.length ? `<div class="tbl"><table><tbody>${iss.map(x => `<tr><td class="small">${fmtDate(x.created_at)}</td><td>${esc(x.kind)}</td><td class="small">${esc(x.description || '')}</td><td>${Equip.issuePill(x.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">None reported.</p>'}
      ${it?.kind === 'machine' ? `<h3 style="font-size:15px;margin:12px 0 4px">Services</h3>${sv.length ? `<div class="tbl"><table><tbody>${sv.map(x => `<tr><td class="small">${fmtDate(x.service_date)}</td><td class="small">${fmt(x.hours_at || 0, 1)} h</td><td class="small">${esc(x.work || '')}</td><td class="n small">${x.cost ? money(Number(x.cost), 0) : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">No services recorded.</p>'}` : ''}
      <h3 style="font-size:15px;margin:12px 0 4px">Movements</h3>${moves.length ? `<div class="tbl"><table><tbody>${moves.map(m => `<tr><td class="small">${fmtDate(m.move_date)}</td><td class="small">${esc(m.type)}</td><td class="small">${esc(locName(S, m.from_loc))} → ${esc(locName(S, m.to_loc))}</td><td class="small muted">${esc(m.ref || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">None yet.</p>'}`,
    buttons: [{ label: 'Report damage / breakdown', value: 'issue' }, ...(it?.kind === 'machine' && can ? [{ label: 'Record service', value: 'svc' }] : []), ...(can ? [{ label: 'Write off', danger: true, value: 'wo' }, { label: 'Save', primary: true, value: w => ({ save: formData(w) }) }] : [{ label: 'Close', primary: true, value: null }])],
  });
  if (!v) return null;
  if (v === 'issue') return await Equip.reportIssue(ctx, S, { asset: a, item: it, projectId: a.project_id });
  if (v === 'svc') return await Equip.recordService(ctx, S, a);
  if (v === 'wo') { if (await confirmDlg('Write off ' + a.tag_no + '?', 'It stays in the records as written off.', 'Write off')) { await store.update('assets', a.id, { status: 'written_off' }); await move(store, { item_id: a.item_id, asset_id: a.id, qty: 1, type: 'writeoff', from_loc: locOf(a), to_loc: 'out' }, me); return true; } return null; }
  if (v.save) { const f = v.save; await store.update('assets', a.id, { make_model: f.make_model || null, serial: f.serial || null, condition: f.condition, hours: f.hours != null ? num(f.hours) : a.hours, purchase_date: f.purchase_date || null, cost: num(f.cost) }); toast('Saved'); return true; }
  return null;
}

// What a site has from stores, and what is on its way (used by the jobcard).
export function siteStores(S, projectId) {
  const loc = 'project:' + projectId;
  return { loc, held: holdings(S, loc), incoming: S.vouchers.filter(v => v.kind === 'issue' && v.status === 'issued' && v.to_loc === loc), returning: S.vouchers.filter(v => v.kind === 'return' && v.status === 'returned' && v.from_loc === loc) };
}
// PPE and personal tools held by one person (for the contract PPE annexure and the person card).
export function personItems(S, personId) { return holdings(S, 'person:' + personId); }
