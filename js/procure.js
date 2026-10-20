// Procurement: price items from the supplier library, create RFQs, capture supplier quotes
// (upload + Claude reads them, or type them in), compare suppliers, select, and raise purchase orders.
import { esc, fmt, money, dialog, formData, toast, confirmDlg, num, itemKey, today, fmtDate, UNITS, CATEGORIES, groupBy, uid } from './util.js';
import { procurementItems } from './spec.js';
import { sortAreas } from './areas.js';
import { editSupplier } from './library.js';
import { openRfqDoc, openPoDoc, rfqText } from './docs.js';

// ------------------------------------------------------------ data load
export async function loadProcurement(store, project) {
  const [areas, spec, rfqs, quotes, sels, pos, suppliers, lib] = await Promise.all([
    store.list('areas', { project_id: project.id }), store.list('spec_items', { project_id: project.id }, 'sort'),
    store.list('rfqs', { project_id: project.id }), store.list('quotes', { project_id: project.id }),
    store.list('selections', { project_id: project.id }, null), store.list('purchase_orders', { project_id: project.id }),
    store.list('suppliers', {}, 'name'), store.list('library_prices', {}, 'price_date'),
  ]);
  const rfqIds = rfqs.map(r => r.id), quoteIds = quotes.map(q => q.id), poIds = pos.map(p => p.id);
  const [rfqLines, quoteLines, poLines] = await Promise.all([
    rfqIds.length ? store.list('rfq_lines', { rfq_id: rfqIds }, 'sort') : [], quoteIds.length ? store.list('quote_lines', { quote_id: quoteIds }, null) : [],
    poIds.length ? store.list('po_lines', { po_id: poIds }, 'sort') : []]);
  const items = procurementItems(spec, sortAreas(areas));
  // RFQ-only extra items join the item list
  for (const l of rfqLines.filter(l => l.extra)) if (!items.find(i => i.item_key === l.item_key)) items.push({ item_key: l.item_key, category: l.category || 'Other', description: l.description, spec: l.spec, unit: l.unit, qty: Number(l.qty) || 0, lines: [], extra: true });
  const sup = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const quoteById = Object.fromEntries(quotes.map(q => [q.id, q]));
  const selBy = Object.fromEntries(sels.map(s => [s.item_key, s]));
  const onPo = new Set(poLines.map(l => l.item_key));
  return { areas, spec, items, rfqs, rfqLines, quotes, quoteLines, quoteById, sels, selBy, pos, poLines, onPo, suppliers, sup, lib };
}

// All prices known for one item: this project's quotes + latest library price per supplier.
export function priceOptions(D, key) {
  const out = [];
  for (const ql of D.quoteLines.filter(l => l.item_key === key && l.unit_price != null)) {
    const q = D.quoteById[ql.quote_id];
    out.push({ source: 'quote', supplier_id: q.supplier_id, unit_price: Number(ql.unit_price), date: q.quote_date, quote_line_id: ql.id, ref: q.quote_ref, lead: ql.lead_time });
  }
  const latest = {};
  for (const lp of D.lib.filter(l => l.item_key === key)) { if (D.quotes.some(q => q.id === lp.quote_id)) continue; const p = latest[lp.supplier_id]; if (!p || String(lp.price_date) >= String(p.price_date)) latest[lp.supplier_id] = lp; }
  for (const lp of Object.values(latest)) out.push({ source: 'library', supplier_id: lp.supplier_id, unit_price: Number(lp.unit_price), date: lp.price_date, library_price_id: lp.id });
  return out.sort((a, b) => a.unit_price - b.unit_price);
}

async function selectPrice(store, project, item, opt) {
  if (!opt) return store.removeWhere('selections', { project_id: project.id, item_key: item.item_key });
  return store.upsert('selections', { project_id: project.id, item_key: item.item_key, supplier_id: opt.supplier_id, unit_price: opt.unit_price, source: opt.source, quote_line_id: opt.quote_line_id || null, library_price_id: opt.library_price_id || null }, 'project_id,item_key');
}

// ------------------------------------------------------------------ view
const SUBS = [['items', 'Items & pricing'], ['rfqs', 'RFQs & quotes'], ['compare', 'Comparison'], ['pos', 'Purchase orders']];
export async function render(root, ctx) {
  const { store, project } = ctx;
  const [sub = 'items', id] = ctx.rest || [];
  const D = await loadProcurement(store, project);
  const priced = D.items.filter(i => D.selBy[i.item_key]).length;
  root.innerHTML = `<div class="page">
    <div class="row"><div class="grow"><div class="eyebrow">Procurement Officer</div><h2 style="font-size:24px">Procurement</h2></div>
      <nav class="subtabs" aria-label="Procurement sections">${SUBS.map(([k, l]) => `<a href="#/p/${project.id}/procure/${k}" class="${(sub === k || (sub === 'rfq' && k === 'rfqs') || (sub === 'po' && k === 'pos')) ? 'on' : ''}">${l}</a>`).join('')}</nav></div>
    <div class="kpis">
      <div class="kpi"><div class="k">Items to buy</div><div class="v">${D.items.length}</div></div>
      <div class="kpi"><div class="k">Priced</div><div class="v">${priced} <span class="small muted">/ ${D.items.length}</span></div></div>
      <div class="kpi"><div class="k">RFQs · quotes</div><div class="v">${D.rfqs.length} · ${D.quotes.length}</div></div>
      <div class="kpi"><div class="k">Purchase orders</div><div class="v">${D.pos.length}</div></div>
    </div>
    <div id="sub"></div></div>`;
  const el = root.querySelector('#sub');
  if (sub === 'rfq' && id) return rfqDetail(el, ctx, D, id);
  if (sub === 'po' && id) return poDetail(el, ctx, D, id);
  if (sub === 'rfqs') return rfqList(el, ctx, D);
  if (sub === 'compare') return compareView(el, ctx, D, null);
  if (sub === 'pos') return poList(el, ctx, D);
  return itemsView(el, ctx, D);
}

// ------------------------------------------------------- items & pricing
function itemsView(el, ctx, D) {
  const { store, project } = ctx;
  if (!D.items.length) { el.innerHTML = `<div class="card empty"><b>Nothing to buy yet</b>Once the QS and Horticulturist have specified items, they appear here for pricing.</div>`; return; }
  const cats = groupBy(D.items, i => i.category || 'Other');
  el.innerHTML = `<section class="card"><div class="hd"><h3>Items from the specification</h3><span class="small muted">Quantities are totals across all areas.</span><span class="grow"></span>
      <button class="btn" id="auto">Price unpriced items from library</button>
      <a class="btn primary" href="#/p/${project.id}/procure/rfqs">Create RFQ</a></div>
    <div class="tbl"><table><thead><tr><th>Item</th><th class="n">Qty</th><th>Unit</th><th>Best known price</th><th>Selected</th><th class="n">Line cost</th><th></th></tr></thead><tbody>
    ${Object.entries(cats).map(([c, its]) => `<tr class="sec"><td colspan="7">${esc(c)}</td></tr>` + its.map(i => {
      const opts = priceOptions(D, i.item_key), best = opts[0], s = D.selBy[i.item_key];
      return `<tr><td><b>${esc(i.description)}</b>${i.spec ? `<div class="small muted">${esc(i.spec)}</div>` : ''}${i.extra ? '<div class="small muted">Added on an RFQ</div>' : ''}</td>
        <td class="n">${fmt(i.qty, 2)}</td><td>${esc(i.unit)}</td>
        <td class="small">${best ? `${money(best.unit_price)} · ${esc(D.sup[best.supplier_id]?.name || '?')} <span class="muted">(${best.source === 'quote' ? 'quote' : 'library'} ${fmtDate(best.date)})</span>` : i.unit_cost != null ? `<span class="muted">QS estimate</span> ${money(i.unit_cost)}` : '<span class="muted">No prices yet</span>'}</td>
        <td class="small">${s ? `<span class="pill ok">${esc(D.sup[s.supplier_id]?.name || '?')}</span> ${money(s.unit_price)}` : '<span class="pill warn">Not priced</span>'}${D.onPo.has(i.item_key) ? ' <span class="pill info">On PO</span>' : ''}</td>
        <td class="n">${s ? money(s.unit_price * i.qty) : '–'}</td>
        <td class="n"><button class="btn small" data-pick="${esc(i.item_key)}">Choose price</button></td></tr>`;
    }).join('')).join('')}
    </tbody></table></div></section>`;
  el.querySelector('#auto').onclick = async () => {
    let n = 0;
    for (const i of D.items) { if (D.selBy[i.item_key]) continue; const o = priceOptions(D, i.item_key).find(x => x.source === 'library'); if (o) { await selectPrice(store, project, i, o); n++; } }
    toast(n ? `Priced ${n} items from the library (lowest latest price).` : 'No library prices found for the unpriced items. Create an RFQ instead.'); ctx.reload();
  };
  el.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => choosePrice(ctx, D, D.items.find(i => i.item_key === b.dataset.pick)));
}

async function choosePrice(ctx, D, item) {
  const { store, project } = ctx;
  const opts = priceOptions(D, item.item_key), s = D.selBy[item.item_key];
  const v = await dialog({
    title: item.description, wide: true,
    body: `<p class="muted">${esc(item.spec || '')} · ${fmt(item.qty, 2)} ${esc(item.unit)}</p>
      ${opts.length ? `<div class="tbl"><table><thead><tr><th></th><th>Supplier</th><th>Source</th><th class="n">Unit price</th><th class="n">Line cost</th></tr></thead><tbody>
      ${opts.map((o, i) => `<tr><td><input type="radio" name="opt" value="${i}" ${s && s.supplier_id === o.supplier_id && Number(s.unit_price) === o.unit_price ? 'checked' : ''} aria-label="Choose ${esc(D.sup[o.supplier_id]?.name)}"></td>
        <td>${esc(D.sup[o.supplier_id]?.name || '?')}</td><td class="small">${o.source === 'quote' ? `Quote ${esc(o.ref || '')} ${fmtDate(o.date)}` : `Library ${fmtDate(o.date)}`}</td>
        <td class="n ${i === 0 ? 'best' : ''}">${money(o.unit_price)}</td><td class="n">${money(o.unit_price * item.qty)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="note">No prices on file for this item yet.</p>'}
      <details><summary class="small">Enter a price by hand (adds it to the supplier library)</summary>
        <div class="grid3" style="margin-top:8px"><label class="f span2">Supplier<select name="ms"><option value="">Choose…</option>${D.suppliers.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
        <label class="f">Unit price (E, excl. VAT)<input name="mp" inputmode="decimal"></label></div></details>`,
    buttons: [...(s ? [{ label: 'Clear selection', value: 'clear' }] : []), { label: 'Cancel', value: null }, { label: 'Use this price', primary: true, value: w => formData(w) }],
  });
  if (!v) return;
  if (v === 'clear') { await selectPrice(store, project, item, null); return ctx.reload(); }
  if (v.ms && num(v.mp) != null) {
    const lp = await store.insert('library_prices', { supplier_id: v.ms, item_key: item.item_key, description: item.description, spec: item.spec, unit: item.unit, unit_price: num(v.mp), price_date: today(), source: 'manual', project_id: project.id });
    await selectPrice(store, project, item, { source: 'library', supplier_id: v.ms, unit_price: num(v.mp), library_price_id: lp.id });
  } else if (v.opt != null && v.opt !== '') await selectPrice(store, project, item, opts[+v.opt]);
  else return toast('Pick a price or enter one.');
  toast('Price selected'); ctx.reload();
}

// ------------------------------------------------------------------ RFQs
function rfqList(el, ctx, D) {
  const { project } = ctx;
  el.innerHTML = `<section class="card"><div class="hd"><h3>Requests for quotation</h3><span class="grow"></span><button class="btn primary" id="new">+ Create RFQ</button></div>
    ${D.rfqs.length ? `<div class="tbl"><table><thead><tr><th>RFQ</th><th>Title</th><th>Suppliers</th><th class="n">Items</th><th class="n">Quotes</th><th>Status</th></tr></thead><tbody>
    ${[...D.rfqs].reverse().map(r => `<tr class="click" data-r="${r.id}"><td><b>${esc(r.number)}</b><div class="small muted">${fmtDate(r.created_at)}</div></td><td>${esc(r.title || '')}</td>
      <td class="small">${(r.supplier_ids || []).map(s => esc(D.sup[s]?.name || '?')).join(', ') || '<span class="muted">None yet</span>'}</td>
      <td class="n">${D.rfqLines.filter(l => l.rfq_id === r.id).length}</td><td class="n">${D.quotes.filter(q => q.rfq_id === r.id).length}</td>
      <td>${statusPill(r.status)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty"><b>No RFQs yet</b>Create one, tick the items you want priced, and send it to as many suppliers as you like. You can make several RFQs from the same item list.</div>`}</section>`;
  el.querySelector('#new').onclick = () => editRfq(ctx, D, null);
  el.querySelectorAll('[data-r]').forEach(r => r.onclick = () => ctx.go(`#/p/${project.id}/procure/rfq/${r.dataset.r}`));
}
export const PO_STATUS = { draft: 'Draft', pending: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected', issued: 'Issued to supplier', received: 'Delivered' };
export const statusPill = s => `<span class="pill ${['sent', 'issued', 'pending'].includes(s) ? 'info' : s === 'closed' ? 'mute' : ['received', 'approved'].includes(s) ? 'ok' : s === 'rejected' ? 'bad' : 'warn'}">${esc({ ...PO_STATUS, sent: 'Sent', closed: 'Closed' }[s] || s)}</span>`;

async function editRfq(ctx, D, rfq) {
  const { store, project } = ctx;
  const existing = rfq ? D.rfqLines.filter(l => l.rfq_id === rfq.id) : [];
  const chosen = new Set(existing.map(l => l.item_key));
  let extras = existing.filter(l => l.extra).map(l => ({ ...l }));
  let supIds = new Set(rfq?.supplier_ids || []);
  const cats = groupBy(D.items.filter(i => !i.extra), i => i.category || 'Other');
  const body = () => `
    <div class="grid2"><label class="f">Title<input name="title" value="${esc(rfq?.title || '')}" placeholder="e.g. Plants and groundcovers"></label>
      <label class="f">Quotes due by<input name="due" type="date" value="${esc(rfq?.due_date || '')}"></label></div>
    <div><div class="row"><b style="font-family:var(--display)">Suppliers</b><span class="grow"></span><button class="btn small" type="button" id="nsup">+ New supplier</button></div>
      <div class="row" style="margin-top:6px">${D.suppliers.map(s => `<label class="chk" style="border:1px solid var(--line);border-radius:999px;padding:4px 10px"><input type="checkbox" data-sup="${s.id}" ${supIds.has(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('') || '<span class="small muted">No suppliers in the library yet. Add one.</span>'}</div></div>
    <div><div class="row"><b style="font-family:var(--display)">Items</b><span class="grow"></span><button class="btn small" type="button" id="all">Tick all</button><button class="btn small" type="button" id="none">Clear</button></div>
      ${Object.entries(cats).map(([c, its]) => `<div class="cat-h"><label class="chk"><input type="checkbox" data-cat="${esc(c)}"> ${esc(c)}</label></div>
        ${its.map(i => `<label class="chk" style="padding:3px 0 3px 18px"><input type="checkbox" data-key="${esc(i.item_key)}" data-c="${esc(c)}" ${chosen.has(i.item_key) ? 'checked' : ''}> <span class="grow">${esc(i.description)} <span class="small muted">${esc(i.spec || '')}</span></span><span class="small"><b>${fmt(i.qty, 2)}</b> ${esc(i.unit)}</span></label>`).join('')}`).join('') || '<p class="small muted">No specified items yet. You can still add items below.</p>'}
    </div>
    <div><div class="row"><b style="font-family:var(--display)">Extra items</b><span class="small muted">not in the specification</span><span class="grow"></span><button class="btn small" type="button" id="addx">+ Add item</button></div>
      ${extras.map((x, i) => `<div class="grid3" style="margin-top:6px" data-x="${i}">
        <input data-f="description" placeholder="Item" value="${esc(x.description || '')}" class="span2"><input data-f="spec" placeholder="Spec / size" value="${esc(x.spec || '')}">
        <select data-f="category">${CATEGORIES.map(c => `<option ${x.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <input data-f="qty" inputmode="decimal" placeholder="Qty" value="${x.qty ?? ''}"><select data-f="unit">${UNITS.map(u => `<option ${x.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>`).join('')}</div>
    <label class="f">Notes to suppliers<textarea name="notes" placeholder="Delivery to site, validity, VAT…">${esc(rfq?.notes || 'Please quote unit prices excluding VAT, with availability and lead time. Delivery to site in Eswatini.')}</textarea></label>`;
  const read = w => {
    w.querySelectorAll('[data-key]').forEach(c => c.checked ? chosen.add(c.dataset.key) : chosen.delete(c.dataset.key));
    supIds = new Set([...w.querySelectorAll('[data-sup]')].filter(c => c.checked).map(c => c.dataset.sup));
    extras = [...w.querySelectorAll('[data-x]')].map(row => { const o = {}; row.querySelectorAll('[data-f]').forEach(f => o[f.dataset.f] = f.value); o.qty = num(o.qty); return o; });
  };
  const wire = w => {
    const re = () => { read(w); const keep = formData(w); w.querySelector('.dlg-body').innerHTML = body(); w.querySelector('[name=title]').value = keep.title; w.querySelector('[name=due]').value = keep.due; w.querySelector('[name=notes]').value = keep.notes; wire(w); };
    w.querySelector('#addx').onclick = () => { read(w); extras.push({ category: 'Other', unit: 'each' }); re(); };
    w.querySelector('#all').onclick = () => w.querySelectorAll('[data-key],[data-cat]').forEach(c => c.checked = true);
    w.querySelector('#none').onclick = () => w.querySelectorAll('[data-key],[data-cat]').forEach(c => c.checked = false);
    w.querySelectorAll('[data-cat]').forEach(cb => cb.onchange = () => w.querySelectorAll(`[data-c="${CSS.escape(cb.dataset.cat)}"]`).forEach(c => c.checked = cb.checked));
    w.querySelector('#nsup').onclick = async () => { read(w); const s = await editSupplier(store, null); if (s) { D.suppliers.push(s); D.sup[s.id] = s; supIds.add(s.id); re(); } };
  };
  const v = await dialog({ title: rfq ? `Edit ${rfq.number}` : 'Create RFQ', wide: true, body: body(), onOpen: wire,
    buttons: [...(rfq ? [{ label: 'Delete RFQ', danger: true, value: 'delete' }] : []), { label: 'Cancel', value: null }, { label: rfq ? 'Save RFQ' : 'Create RFQ', primary: true, value: w => { read(w); return formData(w); } }] });
  if (!v) return;
  if (v === 'delete') { if (await confirmDlg('Delete RFQ?', `Delete ${rfq.number} and its quotes?`)) { await store.removeWhere('quotes', { rfq_id: rfq.id }); await store.remove('rfqs', rfq.id); ctx.go(`#/p/${project.id}/procure/rfqs`); } return; }
  const ex = extras.filter(x => x.description && x.description.trim());
  if (!chosen.size && !ex.length) return toast('Tick at least one item for the RFQ.');
  const row = { project_id: project.id, title: v.title || null, due_date: v.due || null, notes: v.notes || null, supplier_ids: [...supIds] };
  let r = rfq;
  if (rfq) { r = await store.update('rfqs', rfq.id, row); await store.removeWhere('rfq_lines', { rfq_id: rfq.id }); }
  else {
    const n = D.rfqs.length + 1;
    r = await store.insert('rfqs', { ...row, number: `RFQ-${(project.code || project.name).replace(/[^A-Za-z0-9]+/g, '').slice(0, 10).toUpperCase()}-${String(n).padStart(2, '0')}`, status: 'draft' });
  }
  const lines = [
    ...D.items.filter(i => chosen.has(i.item_key) && !i.extra).map((i, k) => ({ rfq_id: r.id, item_key: i.item_key, category: i.category, description: i.description, spec: i.spec, unit: i.unit, qty: +i.qty.toFixed(2), extra: false, sort: k })),
    ...ex.map((x, k) => ({ rfq_id: r.id, item_key: itemKey(x.description, x.spec, x.unit), category: x.category, description: x.description.trim(), spec: x.spec || null, unit: x.unit, qty: x.qty || 0, extra: true, sort: 1000 + k })),
  ];
  await store.insert('rfq_lines', lines);
  toast(rfq ? 'RFQ saved' : `${r.number} created`);
  ctx.go(`#/p/${project.id}/procure/rfq/${r.id}`);
}

function rfqDetail(el, ctx, D, rfqId) {
  const { store, project } = ctx;
  const rfq = D.rfqs.find(r => r.id === rfqId);
  if (!rfq) { el.innerHTML = '<div class="card empty"><b>RFQ not found</b></div>'; return; }
  const lines = D.rfqLines.filter(l => l.rfq_id === rfq.id);
  const quotes = D.quotes.filter(q => q.rfq_id === rfq.id);
  const sups = (rfq.supplier_ids || []).map(id => D.sup[id]).filter(Boolean);
  el.innerHTML = `<div class="stack">
    <section class="card"><div class="hd"><div class="grow"><div class="small muted"><a href="#/p/${project.id}/procure/rfqs">RFQs</a> /</div><h3>${esc(rfq.number)} ${rfq.title ? '· ' + esc(rfq.title) : ''}</h3>
      <div class="small muted">${lines.length} items · ${rfq.due_date ? 'quotes due ' + fmtDate(rfq.due_date) : 'no due date'}</div></div>
      ${statusPill(rfq.status)}
      <select id="st" aria-label="RFQ status" style="width:auto">${['draft', 'sent', 'closed'].map(s => `<option value="${s}" ${rfq.status === s ? 'selected' : ''}>${{ draft: 'Draft', sent: 'Sent', closed: 'Closed' }[s]}</option>`).join('')}</select>
      <button class="btn" id="edit">Edit items & suppliers</button></div>
      <div class="tbl"><table><thead><tr><th>#</th><th>Item</th><th>Spec / size</th><th class="n">Qty</th><th>Unit</th></tr></thead><tbody>
      ${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}${l.extra ? ' <span class="pill mute">extra</span>' : ''}</td><td class="small">${esc(l.spec || '')}</td><td class="n">${fmt(l.qty, 2)}</td><td>${esc(l.unit)}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="card"><div class="hd"><h3>Suppliers</h3><span class="small muted">Send the RFQ, then record each supplier's quote when it comes back.</span></div>
      ${sups.length ? `<div class="tbl"><table><thead><tr><th>Supplier</th><th>Send RFQ</th><th>Quote</th></tr></thead><tbody>
      ${sups.map(s => { const q = quotes.find(x => x.supplier_id === s.id); return `<tr><td><b>${esc(s.name)}</b><div class="small muted">${esc([s.email, s.phone].filter(Boolean).join(' · '))}</div></td>
        <td><div class="row"><button class="btn small" data-doc="${s.id}">Document / PDF</button>${s.email ? `<a class="btn small" href="mailto:${esc(s.email)}?subject=${encodeURIComponent(rfq.number + ' – Request for quotation – ' + project.name)}&body=${encodeURIComponent(rfqText(rfq, lines, project, s))}">Email</a>` : ''}${s.phone ? `<a class="btn small" target="_blank" rel="noopener" href="https://wa.me/${esc(s.phone.replace(/[^0-9]/g, ''))}?text=${encodeURIComponent(rfqText(rfq, lines, project, s))}">WhatsApp</a>` : ''}</div></td>
        <td>${q ? `<span class="pill ok">Received ${fmtDate(q.quote_date)}</span> <button class="btn small" data-q="${q.id}">Open</button>` : `<button class="btn small primary" data-add="${s.id}">Add quote</button>`}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="empty small">No suppliers on this RFQ yet. Use “Edit items & suppliers”.</div>'}</section>
    <div id="cmp"></div></div>`;
  el.querySelector('#edit').onclick = () => editRfq(ctx, D, rfq);
  el.querySelector('#st').onchange = async e => { await store.update('rfqs', rfq.id, { status: e.target.value }); ctx.reload(); };
  el.querySelectorAll('[data-doc]').forEach(b => b.onclick = async () => { openRfqDoc(rfq, lines, project, D.sup[b.dataset.doc]); if (rfq.status === 'draft') { await store.update('rfqs', rfq.id, { status: 'sent' }); } });
  el.querySelectorAll('[data-add]').forEach(b => b.onclick = () => quoteDialog(ctx, D, rfq, lines, D.sup[b.dataset.add], null));
  el.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { const q = D.quotes.find(x => x.id === b.dataset.q); quoteDialog(ctx, D, rfq, lines, D.sup[q.supplier_id], q); });
  compareView(el.querySelector('#cmp'), ctx, D, rfq);
}

// ------------------------------------------------------- supplier quote
async function quoteDialog(ctx, D, rfq, lines, supplier, quote) {
  const { store, project } = ctx;
  const qLines = quote ? D.quoteLines.filter(l => l.quote_id === quote.id) : [];
  const vatRate = Number(project.vat_rate ?? 0.15);
  const st = {
    file_path: quote?.file_path || null, file_name: quote?.file_name || null, mime: null, read_by: quote?.read_by || 'manual',
    prices: Object.fromEntries(lines.map(l => { const q = qLines.find(x => x.item_key === l.item_key); return [l.id, { unit_price: q?.unit_price ?? '', lead_time: q?.lead_time ?? '', notes: q?.notes ?? '' }]; })),
    extra: qLines.filter(q => !lines.some(l => l.item_key === q.item_key)).map(q => ({ ...q })),
  };
  const body = () => `
    <div class="grid3"><label class="f">Supplier<input value="${esc(supplier.name)}" readonly></label>
      <label class="f">Quote ref<input name="quote_ref" value="${esc(quote?.quote_ref || '')}"></label>
      <label class="f">Quote date<input name="quote_date" type="date" value="${esc(quote?.quote_date || today())}"></label></div>
    <div class="dims"><div class="row"><b style="font-family:var(--display)">Supplier's quote file</b><span class="grow"></span>
      <label class="btn small">${st.file_path ? 'Replace file' : 'Upload PDF or photo'}<input type="file" id="qf" accept="application/pdf,image/*" hidden></label>
      <button class="btn small primary" type="button" id="read" ${st.file_path ? '' : 'disabled'}>✦ Read with Claude</button></div>
      <div class="small">${st.file_path ? `📎 <a href="#" id="openf">${esc(st.file_name || 'quote')}</a>` : 'Upload the PDF or a photo of the quote, then let Claude fill in the prices. Or type them in below.'}</div>
      <div id="rmsg" class="small muted" role="status"></div></div>
    <label class="chk"><input type="checkbox" name="vat_included" ${quote?.vat_included ? 'checked' : ''}> Prices below include VAT (they'll be stored excluding VAT at ${fmt(vatRate * 100)}%)</label>
    <div class="tbl"><table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Unit price (E)</th><th>Lead time</th><th>Notes</th></tr></thead><tbody>
      ${lines.map(l => `<tr><td>${esc(l.description)}<div class="small muted">${esc(l.spec || '')} · ${esc(l.unit)}</div></td><td class="n">${fmt(l.qty, 2)}</td>
        <td class="n"><input class="num" data-p="${l.id}" data-f="unit_price" inputmode="decimal" value="${st.prices[l.id].unit_price ?? ''}" aria-label="Unit price for ${esc(l.description)}"></td>
        <td><input data-p="${l.id}" data-f="lead_time" value="${esc(st.prices[l.id].lead_time || '')}" style="width:110px"></td>
        <td><input data-p="${l.id}" data-f="notes" value="${esc(st.prices[l.id].notes || '')}"></td></tr>`).join('')}
    </tbody></table></div>
    ${st.extra.length ? `<div><b style="font-family:var(--display)">Other lines on the quote</b> <span class="small muted">not on the RFQ (kept in the supplier library)</span>
      <div class="tbl"><table><tbody>${st.extra.map((x, i) => `<tr><td>${esc(x.description)} <span class="small muted">${esc(x.unit || '')}</span></td><td class="n">${money(num(x.unit_price))}</td><td class="n"><button class="btn small" type="button" data-rmx="${i}">Remove</button></td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <label class="f">Notes<input name="notes" value="${esc(quote?.notes || '')}" placeholder="Validity, delivery, terms"></label>`;
  const read = w => { w.querySelectorAll('[data-p]').forEach(i => { st.prices[i.dataset.p][i.dataset.f] = i.value; }); };
  const rerender = w => { const keep = formData(w); read(w); w.querySelector('.dlg-body').innerHTML = body(); for (const k of ['quote_ref', 'quote_date', 'notes']) w.querySelector(`[name=${k}]`).value = keep[k]; w.querySelector('[name=vat_included]').checked = keep.vat_included; wire(w); };
  const wire = w => {
    w.querySelector('#qf').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const msg = w.querySelector('#rmsg'); msg.textContent = 'Uploading…';
      try {
        const ext = (f.name.split('.').pop() || 'pdf').toLowerCase();
        const path = `${project.id}/${uid()}.${ext}`;
        await store.upload('quotes', path, f);
        st.file_path = path; st.file_name = f.name; st.mime = f.type; rerender(w);
        w.querySelector('#rmsg').textContent = 'Uploaded. Tap “Read with Claude” to fill in the prices.';
      } catch (err) { msg.textContent = 'Upload failed: ' + err.message; }
    };
    const of = w.querySelector('#openf'); if (of) of.onclick = async e => { e.preventDefault(); const u = await store.fileUrl('quotes', st.file_path); if (u) window.open(u, '_blank'); };
    w.querySelector('#read').onclick = async () => {
      const msg = w.querySelector('#rmsg'); msg.textContent = 'Claude is reading the quote… (10–40 seconds)';
      read(w);
      try {
        const r = await store.claude('extract_quote', { file_path: st.file_path, file_name: st.file_name, supplier: supplier.name, rfq_lines: lines.map(l => ({ id: l.id, description: l.description, spec: l.spec, unit: l.unit, qty: l.qty })) });
        let n = 0;
        for (const ln of r.lines || []) {
          if (ln.rfq_line_id && st.prices[ln.rfq_line_id]) { st.prices[ln.rfq_line_id] = { unit_price: ln.unit_price ?? '', lead_time: ln.lead_time || '', notes: ln.notes || '' }; n++; }
          else if (ln.description && ln.unit_price != null) st.extra.push({ description: ln.description, spec: ln.spec || null, unit: ln.unit || 'each', qty: ln.qty, unit_price: ln.unit_price, notes: ln.notes || null });
        }
        st.read_by = 'claude';
        const keep = formData(w);
        if (r.quote_ref && !keep.quote_ref) keep.quote_ref = r.quote_ref;
        if (r.quote_date) keep.quote_date = r.quote_date;
        if (typeof r.vat_included === 'boolean') keep.vat_included = r.vat_included;
        w.querySelector('.dlg-body').innerHTML = body();
        for (const k of ['quote_ref', 'quote_date', 'notes']) w.querySelector(`[name=${k}]`).value = keep[k] || '';
        w.querySelector('[name=vat_included]').checked = !!keep.vat_included;
        wire(w);
        w.querySelector('#rmsg').innerHTML = `Claude matched <b>${n}</b> of ${lines.length} items${st.extra.length ? ` and found ${st.extra.length} other lines` : ''}. ${esc(r.note || '')} Please check the figures before saving.`;
      } catch (err) { msg.textContent = 'Claude could not read it: ' + err.message; }
    };
    w.querySelectorAll('[data-rmx]').forEach(b => b.onclick = () => { read(w); st.extra.splice(+b.dataset.rmx, 1); rerender(w); });
  };
  const v = await dialog({ title: `${supplier.name} · quote for ${rfq.number}`, wide: true, body: body(), onOpen: wire,
    buttons: [...(quote ? [{ label: 'Delete quote', danger: true, value: 'delete' }] : []), { label: 'Cancel', value: null }, { label: 'Save quote', primary: true, value: w => { read(w); return formData(w); } }] });
  if (!v) return;
  if (v === 'delete') { if (await confirmDlg('Delete quote?', `Delete ${supplier.name}'s quote? Library prices it created stay in the library.`)) { await store.remove('quotes', quote.id); ctx.reload(); } return; }
  const k = v.vat_included ? 1 / (1 + vatRate) : 1;
  const row = { project_id: project.id, rfq_id: rfq.id, supplier_id: supplier.id, quote_ref: v.quote_ref || null, quote_date: v.quote_date || today(), vat_included: !!v.vat_included, file_path: st.file_path, file_name: st.file_name, read_by: st.read_by, notes: v.notes || null };
  const q = quote ? await store.update('quotes', quote.id, row) : await store.insert('quotes', row);
  if (quote) await store.removeWhere('quote_lines', { quote_id: quote.id });
  const ql = [
    ...lines.filter(l => num(st.prices[l.id].unit_price) != null).map(l => ({ quote_id: q.id, item_key: l.item_key, description: l.description, spec: l.spec, unit: l.unit, qty: l.qty, unit_price: +(num(st.prices[l.id].unit_price) * k).toFixed(2), lead_time: st.prices[l.id].lead_time || null, notes: st.prices[l.id].notes || null })),
    ...st.extra.filter(x => num(x.unit_price) != null).map(x => ({ quote_id: q.id, item_key: itemKey(x.description, x.spec, x.unit), description: x.description, spec: x.spec, unit: x.unit, qty: num(x.qty), unit_price: +(num(x.unit_price) * k).toFixed(2), notes: x.notes || null })),
  ];
  if (ql.length) await store.insert('quote_lines', ql);
  // Update the general supplier library with every priced line.
  if (quote) await store.removeWhere('library_prices', { quote_id: quote.id });
  if (ql.length) await store.insert('library_prices', ql.map(l => ({ supplier_id: supplier.id, item_key: l.item_key, description: l.description, spec: l.spec, unit: l.unit, unit_price: l.unit_price, price_date: row.quote_date, source: 'quote', quote_id: q.id, project_id: project.id })));
  toast(`Quote saved · ${ql.length} prices added to the supplier library`);
  ctx.reload();
}

// ------------------------------------------------------------ comparison
function compareView(el, ctx, D, rfq) {
  const { store, project } = ctx;
  const keys = rfq ? D.rfqLines.filter(l => l.rfq_id === rfq.id).map(l => l.item_key) : D.items.map(i => i.item_key);
  const items = keys.map(k => D.items.find(i => i.item_key === k) || (() => { const l = D.rfqLines.find(x => x.item_key === k); return l && { item_key: k, description: l.description, spec: l.spec, unit: l.unit, qty: Number(l.qty) || 0, category: l.category }; })()).filter(Boolean);
  const quotes = rfq ? D.quotes.filter(q => q.rfq_id === rfq.id) : D.quotes;
  const supIds = [...new Set(quotes.map(q => q.supplier_id))];
  const cell = (key, sid) => { const ls = D.quoteLines.filter(l => l.item_key === key && quotes.some(q => q.id === l.quote_id && q.supplier_id === sid) && l.unit_price != null); return ls.length ? ls.reduce((a, b) => Number(a.unit_price) <= Number(b.unit_price) ? a : b) : null; };
  const libBest = key => priceOptions(D, key).find(o => o.source === 'library');
  if (!items.length) { el.innerHTML = '<div class="card empty"><b>Nothing to compare yet</b>Create an RFQ and record supplier quotes.</div>'; return; }
  const totals = Object.fromEntries(supIds.map(s => [s, 0]));
  el.innerHTML = `<section class="card"><div class="hd"><h3>Price comparison${rfq ? '' : ' · all quotes'}</h3><span class="small muted">Lowest price per item is highlighted. Tick the supplier to use for each item.</span><span class="grow"></span>
      <button class="btn" id="lowest" ${supIds.length ? '' : 'disabled'}>Tick lowest for all</button>
      <button class="btn primary" id="gen">Generate purchase orders</button></div>
    ${supIds.length ? '' : '<div class="note" style="margin:12px 14px">No quotes recorded yet. Library prices are shown where known.</div>'}
    <div class="tbl"><table><thead><tr><th>Item</th><th class="n">Qty</th>${supIds.map(s => `<th class="n">${esc(D.sup[s]?.name || '?')}</th>`).join('')}<th class="n">Library</th><th>Selected</th></tr></thead><tbody>
    ${items.map(i => {
      const cells = supIds.map(s => cell(i.item_key, s));
      const lb = libBest(i.item_key);
      const vals = [...cells.map(c => c ? Number(c.unit_price) : Infinity), lb ? lb.unit_price : Infinity];
      const min = Math.min(...vals);
      const sel = D.selBy[i.item_key];
      cells.forEach((c, k) => { if (c) totals[supIds[k]] += Number(c.unit_price) * i.qty; });
      return `<tr><td><b>${esc(i.description)}</b><div class="small muted">${esc(i.spec || '')}</div></td><td class="n">${fmt(i.qty, 2)} ${esc(i.unit)}</td>
        ${cells.map((c, k) => `<td class="n ${c && Number(c.unit_price) === min ? 'best' : ''}">${c ? `<label class="chk" style="justify-content:flex-end"><input type="radio" name="s-${esc(i.item_key)}" data-key="${esc(i.item_key)}" data-ql="${c.id}" data-sup="${supIds[k]}" data-price="${c.unit_price}" ${sel && sel.quote_line_id === c.id ? 'checked' : ''}> ${money(Number(c.unit_price))}</label>${c.lead_time ? `<div class="small muted">${esc(c.lead_time)}</div>` : ''}` : '<span class="muted">–</span>'}</td>`).join('')}
        <td class="n ${lb && lb.unit_price === min ? 'best' : ''}">${lb ? `<label class="chk" style="justify-content:flex-end"><input type="radio" name="s-${esc(i.item_key)}" data-key="${esc(i.item_key)}" data-lib="${lb.library_price_id}" data-sup="${lb.supplier_id}" data-price="${lb.unit_price}" ${sel && sel.library_price_id === lb.library_price_id ? 'checked' : ''}> ${money(lb.unit_price)}</label><div class="small muted">${esc(D.sup[lb.supplier_id]?.name || '')}</div>` : '<span class="muted">–</span>'}</td>
        <td class="small">${sel ? `<span class="pill ok">${esc(D.sup[sel.supplier_id]?.name || '?')}</span>` : '<span class="pill warn">None</span>'}${D.onPo.has(i.item_key) ? ' <span class="pill info">On PO</span>' : ''}</td></tr>`;
    }).join('')}
    ${supIds.length ? `<tr class="tot"><td>Total of items each supplier quoted</td><td></td>${supIds.map(s => `<td class="n">${money(totals[s])}</td>`).join('')}<td></td><td></td></tr>` : ''}
    </tbody></table></div></section>`;
  el.querySelectorAll('input[type=radio][data-key]').forEach(r => r.onchange = async () => {
    const item = items.find(i => i.item_key === r.dataset.key);
    await selectPrice(store, project, item, { source: r.dataset.ql ? 'quote' : 'library', supplier_id: r.dataset.sup, unit_price: Number(r.dataset.price), quote_line_id: r.dataset.ql || null, library_price_id: r.dataset.lib || null });
    D.selBy[item.item_key] = { supplier_id: r.dataset.sup, quote_line_id: r.dataset.ql || null, library_price_id: r.dataset.lib || null, unit_price: Number(r.dataset.price) };
    const td = r.closest('tr').lastElementChild; td.innerHTML = `<span class="pill ok">${esc(D.sup[r.dataset.sup]?.name || '?')}</span>${D.onPo.has(item.item_key) ? ' <span class="pill info">On PO</span>' : ''}`;
  });
  el.querySelector('#lowest').onclick = async () => {
    for (const i of items) {
      const opts = [...supIds.map(s => { const c = cell(i.item_key, s); return c && { source: 'quote', supplier_id: s, unit_price: Number(c.unit_price), quote_line_id: c.id }; }), libBest(i.item_key)].filter(Boolean).sort((a, b) => a.unit_price - b.unit_price);
      if (opts[0]) await selectPrice(store, project, i, opts[0]);
    }
    toast('Lowest prices selected'); ctx.reload();
  };
  el.querySelector('#gen').onclick = () => generatePOs(ctx);
}

// -------------------------------------------------------- purchase orders
async function generatePOs(ctx) {
  const { store, project } = ctx;
  const D = await loadProcurement(store, project);
  const todo = D.items.filter(i => D.selBy[i.item_key] && D.selBy[i.item_key].supplier_id && !D.onPo.has(i.item_key));
  if (!todo.length) return dialog({ title: 'Nothing to order', body: '<p>Every selected item is already on a purchase order, or no prices are selected yet.</p>' });
  const bySup = groupBy(todo, i => D.selBy[i.item_key].supplier_id);
  const ok = await dialog({
    title: 'Generate purchase orders', wide: true,
    body: `<p>This creates <b>${Object.keys(bySup).length}</b> draft purchase orders from the selected prices:</p>
      <div class="tbl"><table><thead><tr><th>Supplier</th><th class="n">Items</th><th class="n">Value excl. VAT</th></tr></thead><tbody>
      ${Object.entries(bySup).map(([s, its]) => `<tr><td>${esc(D.sup[s]?.name || '?')}</td><td class="n">${its.length}</td><td class="n">${money(its.reduce((t, i) => t + i.qty * Number(D.selBy[i.item_key].unit_price), 0))}</td></tr>`).join('')}
      </tbody></table></div><p class="small muted">You can edit quantities, prices and delivery details before issuing each PO.</p>`,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Create POs', primary: true, value: true }],
  });
  if (!ok) return;
  const all = await store.list('purchase_orders', {}, null);
  let n = all.length;
  const yr = new Date().getFullYear();
  for (const [s, its] of Object.entries(bySup)) {
    n++;
    const po = await store.insert('purchase_orders', { project_id: project.id, supplier_id: s, number: `DG-PO-${yr}-${String(n).padStart(3, '0')}`, status: 'draft', po_date: today(), delivery: project.site_address || project.name, vat_rate: project.vat_rate ?? 0.15 });
    await store.insert('po_lines', its.map((i, k) => ({ po_id: po.id, item_key: i.item_key, description: i.description, spec: i.spec, unit: i.unit, qty: +i.qty.toFixed(2), unit_price: Number(D.selBy[i.item_key].unit_price), sort: k })));
  }
  toast('Purchase orders created');
  ctx.go(`#/p/${project.id}/procure/pos`);
}

function poList(el, ctx, D) {
  const { project } = ctx;
  const pend = D.pos.filter(p => p.status === 'pending').length;
  const total = po => { const ls = D.poLines.filter(l => l.po_id === po.id); const sub = ls.reduce((t, l) => t + Number(l.qty) * Number(l.unit_price), 0); return sub * (1 + Number(po.vat_rate ?? 0.15)); };
  el.innerHTML = `<section class="card"><div class="hd"><h3>Purchase orders</h3><span class="grow"></span><button class="btn primary" id="gen">Generate from selected prices</button></div>
    ${pend ? `<div class="note warn" style="margin:12px 14px">${pend} purchase order${pend > 1 ? 's are' : ' is'} awaiting approval${ctx.me?.role === 'admin' ? ' by you' : ' by Matt'}.</div>` : ''}
    ${D.pos.length ? `<div class="tbl"><table><thead><tr><th>PO</th><th>Supplier</th><th class="n">Lines</th><th class="n">Total incl. VAT</th><th>Status</th></tr></thead><tbody>
    ${[...D.pos].reverse().map(p => `<tr class="click" data-p="${p.id}"><td><b>${esc(p.number)}</b><div class="small muted">${fmtDate(p.po_date)}</div></td><td>${esc(D.sup[p.supplier_id]?.name || '?')}</td>
      <td class="n">${D.poLines.filter(l => l.po_id === p.id).length}</td><td class="n">${money(total(p))}</td><td>${statusPill(p.status)}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty"><b>No purchase orders yet</b>Select a price for each item (Items & pricing or Comparison), then generate POs. One PO is created per supplier.</div>`}</section>`;
  el.querySelector('#gen').onclick = () => generatePOs(ctx);
  el.querySelectorAll('[data-p]').forEach(r => r.onclick = () => ctx.go(`#/p/${project.id}/procure/po/${r.dataset.p}`));
}

function poDetail(el, ctx, D, poId) {
  const { store, project } = ctx;
  const po = D.pos.find(p => p.id === poId);
  if (!po) { el.innerHTML = '<div class="card empty"><b>PO not found</b></div>'; return; }
  const lines = D.poLines.filter(l => l.po_id === po.id);
  const s = D.sup[po.supplier_id] || {};
  const vat = Number(po.vat_rate ?? 0.15);
  const sub = lines.reduce((t, l) => t + Number(l.qty) * Number(l.unit_price), 0);
  el.innerHTML = `<section class="card"><div class="hd"><div class="grow"><div class="small muted"><a href="#/p/${project.id}/procure/pos">Purchase orders</a> /</div><h3>${esc(po.number)} · ${esc(s.name || '')}</h3></div>
      ${statusPill(po.status)}${poActions(po, ctx.me)}
      <button class="btn" id="doc">Document / PDF</button>${s.email ? `<a class="btn" href="mailto:${esc(s.email)}?subject=${encodeURIComponent('Purchase order ' + po.number + ' – ' + project.name)}&body=${encodeURIComponent(`Dear ${s.contact || s.name},\n\nPlease find our purchase order ${po.number} for ${project.name} attached.\n\nKind regards,\nDu Green Procurement`)}">Email</a>` : ''}
      <button class="btn danger" id="del">Delete</button></div>
    <div class="bd grid2"><label class="f">Deliver to<input id="dl" value="${esc(po.delivery || '')}"></label><label class="f">Notes<input id="nt" value="${esc(po.notes || '')}"></label></div>
    <div class="tbl"><table><thead><tr><th>Item</th><th class="n">Qty</th><th>Unit</th><th class="n">Unit price</th><th class="n">Total</th></tr></thead><tbody>
    ${lines.map(l => `<tr><td>${esc(l.description)}<div class="small muted">${esc(l.spec || '')}</div></td><td class="n"><input class="num" data-l="${l.id}" data-f="qty" value="${l.qty}" inputmode="decimal" aria-label="Quantity"></td><td>${esc(l.unit)}</td>
      <td class="n"><input class="num" data-l="${l.id}" data-f="unit_price" value="${l.unit_price}" inputmode="decimal" aria-label="Unit price"></td><td class="n">${money(Number(l.qty) * Number(l.unit_price))}</td></tr>`).join('')}
    <tr class="tot"><td colspan="4">Subtotal</td><td class="n">${money(sub)}</td></tr><tr><td colspan="4">VAT ${fmt(vat * 100)}%</td><td class="n">${money(sub * vat)}</td></tr><tr class="tot"><td colspan="4">Total</td><td class="n">${money(sub * (1 + vat))}</td></tr>
    </tbody></table></div></section>`;
  el.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => { await poAct(store, po, b.dataset.act, ctx.me); ctx.reload(); });
  if (!['draft', 'pending', 'rejected'].includes(po.status)) el.querySelectorAll('[data-l]').forEach(i => i.disabled = true);
  el.querySelector('#doc').onclick = () => openPoDoc(po, lines, project, s);
  el.querySelector('#del').onclick = async () => { if (await confirmDlg('Delete PO?', `Delete ${po.number}? Its items become available for a new PO.`)) { await store.remove('purchase_orders', po.id); ctx.go(`#/p/${project.id}/procure/pos`); } };
  el.querySelector('#dl').onchange = e => store.update('purchase_orders', po.id, { delivery: e.target.value });
  el.querySelector('#nt').onchange = e => store.update('purchase_orders', po.id, { notes: e.target.value });
  el.querySelectorAll('[data-l]').forEach(i => i.onchange = async () => { await store.update('po_lines', i.dataset.l, { [i.dataset.f]: num(i.value) ?? 0 }); ctx.reload(); });
}

// ---- PO approval flow: draft → awaiting approval → approved → issued → delivered
export function poActions(po, me) {
  const admin = me?.role === 'admin';
  const b = (act, label, cls = '') => `<button class="btn ${cls}" data-act="${act}">${label}</button>`;
  switch (po.status) {
    case 'draft': case 'rejected': return b('submit', 'Submit for approval', 'primary') + (admin ? b('approve', 'Approve now') : '');
    case 'pending': return admin ? b('approve', 'Approve', 'primary') + b('reject', 'Reject', 'danger') : '<span class="small muted">Waiting for Matt to approve</span>';
    case 'approved': return b('issue', 'Mark as sent to supplier', 'primary');
    case 'issued': return b('receive', 'Mark as delivered', 'primary');
    default: return '';
  }
}
export async function poAct(store, po, act, me) {
  const now = new Date().toISOString();
  const patch = { submit: { status: 'pending', submitted_by: me?.id && me.id !== 'demo-user' ? me.id : null },
    approve: { status: 'approved', approved_at: now, approved_by: me?.id && me.id !== 'demo-user' ? me.id : null },
    reject: { status: 'rejected' }, issue: { status: 'issued' }, receive: { status: 'received', received_at: now } }[act];
  if (!patch) return;
  await store.update('purchase_orders', po.id, patch);
  toast({ submit: 'Sent for approval', approve: 'Approved', reject: 'Rejected', issue: 'Marked as sent', receive: 'Marked as delivered' }[act]);
}
