// Requests from site: the supervisor asks for materials, tools, plant hire, fuel, labour or transport →
// Ops manager / Procurement approve within their limit (Matt above it) → it is supplied from Central Stores,
// ordered (PO), hired (hire order) or arranged → the supervisor logs on the jobcard what was used or installed.
import { esc, fmt, money, dialog, formData, toast, confirmDlg, num, today, fmtDate, addDays, itemKey, UNITS, approvalCheck, DEFAULT_LIMITS, canStores, TOOL_LIST, FUEL_TYPES } from './util.js';
import { getSetting } from './store.js';
import { nextPoNumber } from './procure.js';

export const REQ_KINDS = ['Materials', 'Tools / equipment', 'Plant hire', 'Fuel', 'Labour', 'Transport', 'Information / decision', 'Other'];
export const REQ_STATUS = { pending: 'Waiting for approval', approved: 'Approved – to supply', declined: 'Declined', fulfilling: 'Being supplied', on_site: 'On site / in use', complete: 'Complete', done: 'Done' };
export const reqPill = s => `<span class="pill ${{ pending: 'warn', approved: 'info', fulfilling: 'info', on_site: 'info', declined: 'bad', complete: 'ok', done: 'ok' }[s] || 'mute'}">${esc(REQ_STATUS[s] || s)}</span>`;
export const HIRE_BASIS = { hour: 'per hour', day: 'per day', week: 'per week', load: 'per load' };
const ROUTES = { stores: 'Issued from Central Stores', po: 'Ordered from a supplier', hire: 'Hired from a supplier', arranged: 'Arranged' };

export async function getLimits(store) { return await getSetting(store, 'approval_limits', null) || DEFAULT_LIMITS; }
export const reqValue = r => (r.lines || []).reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.est_rate) || 0), 0) + (r.hire ? (Number(r.hire.rate) || 0) * (Number(r.hire.est_qty) || 0) : 0);

// Quantity of each line used so far, from submitted jobcards.
export function usedSoFar(r, jobcards) {
  const used = (r.lines || []).map(() => 0); let hire = 0;
  for (const j of jobcards.filter(j => j.status !== 'draft')) {
    for (const x of j.resources || []) if (x.request_id === r.id && used[x.line] != null) used[x.line] += Number(x.qty) || 0;
    for (const h of j.hire || []) if (r.po_id && h.po_id === r.po_id) hire += Number(h.qty) || 0;
  }
  return { used, hire };
}

// ------------------------------------------------------------------ create
export async function newRequest(ctx, D = {}, pre = {}) {
  const { store, project } = ctx;
  let kind = pre.kind || 'Materials';
  let lines = pre.lines || [{ name: '', qty: 1, unit: 'each', est_rate: '' }];
  const items = await store.list('stock_items', {}, 'name').catch(() => []);
  const names = [...new Set([...items.filter(i => i.active !== false).map(i => i.name), ...TOOL_LIST, ...FUEL_TYPES])];
  const body = () => `<div class="grid2"><label class="f">Type<select name="kind">${REQ_KINDS.map(k => `<option ${kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label><label class="f">Needed by<input name="needed_by" type="date" value="${esc(pre.needed_by || addDays(today(), 2))}"></label></div>
    <label class="f">What is it for?<input name="description" required value="${esc(pre.description || '')}" placeholder="${kind === 'Plant hire' ? 'e.g. TLB to dig irrigation trenches in L1' : 'e.g. Topsoil and compost for G4'}"></label>
    <datalist id="dl-rq">${names.map(n => `<option>${esc(n)}</option>`).join('')}</datalist>
    ${kind === 'Plant hire' ? `<div class="dims"><b style="font-family:var(--display)">Plant to hire</b>
        <div class="grid3"><label class="f span2">Machine<input name="h_plant" list="dl-rq" value="${esc(pre.hire?.plant || 'TLB')}"></label><label class="f">Charged<select name="h_basis">${Object.entries(HIRE_BASIS).map(([k, l]) => `<option value="${k}" ${(pre.hire?.basis || 'hour') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
        <div class="grid3"><label class="f">Estimated hours / days<input name="h_qty" inputmode="decimal" value="${pre.hire?.est_qty ?? ''}"></label><label class="f">Expected rate (E, optional)<input name="h_rate" inputmode="decimal" value="${pre.hire?.rate ?? ''}"></label><label class="f">From<input name="h_start" type="date" value="${esc(pre.hire?.start || addDays(today(), 1))}"></label></div></div>`
      : `<div class="tbl"><table><thead><tr><th>Item</th><th class="n">Qty</th><th>Unit</th><th class="n">Est. rate (E)</th></tr></thead><tbody id="rl">${lines.map((l, i) => `<tr><td><input data-l="${i}" data-k="name" list="dl-rq" value="${esc(l.name)}" placeholder="item"></td><td class="n"><input class="num" style="width:70px" data-l="${i}" data-k="qty" inputmode="decimal" value="${l.qty ?? ''}"></td>
        <td><select data-l="${i}" data-k="unit">${[...new Set(['each', 'L', ...UNITS])].map(u => `<option ${l.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></td><td class="n"><input class="num" style="width:80px" data-l="${i}" data-k="est_rate" inputmode="decimal" value="${l.est_rate ?? ''}" placeholder="if known"></td></tr>`).join('')}</tbody></table></div>
      <button class="btn small" type="button" id="radd">+ Line</button>`}
    <label class="f">Requested by<input name="requested_by" value="${esc(pre.requested_by || ctx.me?.full_name || '')}"></label>`;
  const read = w => { kind = w.querySelector('[name=kind]').value; w.querySelectorAll('[data-l]').forEach(i => { lines[+i.dataset.l][i.dataset.k] = ['qty', 'est_rate'].includes(i.dataset.k) ? num(i.value) : i.value; }); };
  const v = await dialog({
    title: 'Request from site', wide: true, sticky: true, body: body(),
    onOpen: w => { const wire = () => { w.querySelector('[name=kind]').onchange = () => { const keep = { description: w.querySelector('[name=description]').value }; read(w); pre.description = keep.description; w.querySelector('.dlg-body').innerHTML = body(); wire(); }; w.querySelector('#radd')?.addEventListener('click', () => { read(w); lines.push({ name: '', qty: 1, unit: 'each', est_rate: '' }); pre.description = w.querySelector('[name=description]').value; w.querySelector('.dlg-body').innerHTML = body(); wire(); }); }; wire(); },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Send for approval', primary: true, value: w => { read(w); return formData(w); }, validate: w => !!w.querySelector('[name=description]').value.trim() }],
  });
  if (!v) return null;
  const row = { project_id: project.id, kind: v.kind, description: v.description.trim(), needed_by: v.needed_by || null, requested_by: v.requested_by || null, status: 'pending' };
  if (v.kind === 'Plant hire') { row.hire = { plant: v.h_plant || 'Plant', basis: v.h_basis, est_qty: num(v.h_qty), rate: num(v.h_rate), start: v.h_start || null }; row.lines = []; row.items = `${row.hire.plant} · ${row.hire.est_qty ?? '?'} ${row.hire.basis}s`; }
  else { row.lines = lines.filter(l => (l.name || '').trim()).map(l => ({ name: l.name.trim(), qty: Number(l.qty) || 1, unit: l.unit || 'each', est_rate: num(l.est_rate) })); row.items = row.lines.map(l => `${fmt(l.qty)} ${l.unit} ${l.name}`).join(', ') || null; }
  row.est_value = reqValue(row);
  const out = await store.insert('requests', row);
  toast('Request sent for approval'); return out;
}

// ----------------------------------------------------------------- approve
export async function decideRequest(ctx, r, decision) {
  const { store, me } = ctx;
  if (decision === 'approved') {
    const chk = approvalCheck(me, r.est_value ?? reqValue(r), await getLimits(store));
    if (!chk.ok) { await store.update('requests', r.id, { escalated: true }); toast(chk.why); return ctx.reload(); }
  } else if (decision === 'declined' && !['admin', 'ops', 'procurement'].includes(me?.role)) return toast('Only Matt, the Operations Manager or Procurement can decline.');
  let response = r.response || '';
  if (!['done', 'complete'].includes(decision)) {
    const v = await dialog({ title: `${decision === 'approved' ? 'Approve' : 'Decline'} request`, body: `<p><b>${esc(r.description)}</b></p><p class="small muted">${esc(r.items || '')}${r.est_value ? ` · est. ${money(Number(r.est_value))}` : ''}</p><label class="f">Reply to the supervisor (optional)<input name="r" value="${esc(response)}"></label>`, buttons: [{ label: 'Cancel', value: null }, { label: decision === 'approved' ? 'Approve' : 'Decline', primary: decision === 'approved', danger: decision !== 'approved', value: w => w.querySelector('[name=r]').value }] });
    if (v == null) return; response = v;
  }
  await store.update('requests', r.id, { status: decision, response, decided_at: new Date().toISOString(), decided_by: me?.id && me.id !== 'demo-user' ? me.id : null, approved_by_name: decision === 'approved' ? (me?.full_name || me?.email || 'Approved') : r.approved_by_name || null, approved_role: decision === 'approved' ? me?.role : null });
  toast({ approved: 'Approved', declined: 'Declined', done: 'Marked done', complete: 'Closed' }[decision]);
  if (decision === 'approved' && canStores(me) && await confirmDlg('Supply it now?', 'Issue from stores, raise a PO or hire order, or mark it arranged.', 'Supply now')) return fulfilRequest(ctx, { ...r, status: 'approved' });
  ctx.reload();
}

// ------------------------------------------------------------------ supply
export async function fulfilRequest(ctx, r) {
  const { store, project, me } = ctx;
  // Suggest stores when everything asked for is in Central Stores.
  const stock = await store.list('stock_items', {}, null).catch(() => []);
  const inStores = (r.lines || []).length && (r.lines || []).every(l => stock.some(i => i.active !== false && i.name.toLowerCase() === String(l.name).toLowerCase()));
  const def = r.kind === 'Plant hire' ? 'hire' : inStores || ['Tools / equipment', 'Fuel'].includes(r.kind) ? 'stores' : ['Labour', 'Transport', 'Information / decision', 'Other'].includes(r.kind) ? 'arranged' : 'po';
  const route = await dialog({
    title: 'How will this be supplied?', body: `<p><b>${esc(r.description)}</b><br><span class="small muted">${esc(r.items || '')}</span></p>
      ${Object.entries(ROUTES).map(([k, l]) => `<label class="chk" style="display:flex;margin:6px 0"><input type="radio" name="rt" value="${k}" ${k === def ? 'checked' : ''}> ${l}</label>`).join('')}`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Next', primary: true, value: w => w.querySelector('[name=rt]:checked')?.value }],
  });
  if (!route) return;
  const proj = project || await store.get('projects', r.project_id);
  if (route === 'stores') {
    const Stores = await import('./stores.js');
    const S = await Stores.loadStores(store);
    const lines = (r.lines || []).map(l => { const it = S.items.find(i => i.active !== false && i.name.toLowerCase() === String(l.name).toLowerCase()); return { item_id: it?.id || '', qty: l.qty, name: l.name }; });
    const v = await Stores.issueDialog(Object.assign(Object.create(ctx), { project: proj }), S, { projectId: r.project_id, lines, requestId: r.id, requestNote: r.description });
    if (!v) return;
    await store.update('requests', r.id, { route, issue_id: v.id, status: 'fulfilling' });
  } else if (route === 'po' || route === 'hire') {
    const sups = await store.list('suppliers', {}, 'name');
    if (!sups.length) { toast('Add the supplier under Suppliers first'); return; }
    const hire = route === 'hire';
    const h = r.hire || { plant: (r.lines?.[0]?.name) || 'Plant', basis: 'day', est_qty: r.lines?.[0]?.qty || 1, rate: r.lines?.[0]?.est_rate };
    const v = await dialog({
      title: hire ? 'Hire order' : 'Purchase order from request', wide: true, sticky: true,
      body: `<label class="f">Supplier<select name="s">${sups.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
        ${hire ? `<div class="grid3"><label class="f span2">Machine<input name="plant" value="${esc(h.plant)}"></label><label class="f">Charged<select name="basis">${Object.entries(HIRE_BASIS).map(([k, l]) => `<option value="${k}" ${h.basis === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
          <div class="grid3"><label class="f">Agreed rate (E excl. VAT)<input name="rate" inputmode="decimal" value="${h.rate ?? ''}" required></label><label class="f">Estimated qty<input name="qty" inputmode="decimal" value="${h.est_qty ?? ''}"></label><label class="f">On site from<input type="date" name="start" value="${esc(h.start || today())}"></label></div>
          <label class="chk"><input type="checkbox" name="op" checked> Rate includes operator</label><label class="chk"><input type="checkbox" name="fuel"> Rate includes fuel</label>`
        : `<div class="tbl"><table><thead><tr><th>Item</th><th class="n">Qty</th><th>Unit</th><th class="n">Price (E excl. VAT)</th></tr></thead><tbody>${(r.lines || []).map((l, i) => `<tr><td>${esc(l.name)}</td><td class="n"><input class="num" style="width:70px" data-q="${i}" value="${l.qty}"></td><td>${esc(l.unit)}</td><td class="n"><input class="num" style="width:90px" data-p="${i}" value="${l.est_rate ?? ''}"></td></tr>`).join('')}</tbody></table></div>`}
        <p class="small muted">The request is already approved, so the order is created as approved. Send it to the supplier from Procurement → Purchase orders.</p>`,
      buttons: [{ label: 'Cancel', value: null }, { label: hire ? 'Create hire order' : 'Create PO', primary: true, value: w => ({ ...formData(w), q: [...w.querySelectorAll('[data-q]')].map(i => num(i.value)), p: [...w.querySelectorAll('[data-p]')].map(i => num(i.value)) }), validate: w => !hire || num(w.querySelector('[name=rate]').value) != null }],
    });
    if (!v) return;
    const po = await store.insert('purchase_orders', { project_id: r.project_id, supplier_id: v.s, number: await nextPoNumber(store), status: 'approved', approved_at: new Date().toISOString(), po_date: today(), delivery: proj?.site_address || proj?.name, vat_rate: proj?.vat_rate ?? 0.15, request_id: r.id,
      notes: `From site request: ${r.description}${r.approved_by_name ? ` (approved by ${r.approved_by_name})` : ''}`,
      ...(hire ? { hire: true, hire_item: v.plant, hire_basis: v.basis, hire_rate: num(v.rate), hire_start: v.start || today(), hire_terms: [v.op ? 'incl. operator' : 'excl. operator', v.fuel ? 'incl. fuel' : 'excl. fuel'].join(', ') } : {}) });
    const pl = hire ? [{ po_id: po.id, item_key: itemKey('Hire: ' + v.plant, '', v.basis), description: `Hire of ${v.plant} (${v.op ? 'with operator' : 'dry'}, ${v.fuel ? 'fuel incl.' : 'fuel excl.'})`, spec: HIRE_BASIS[v.basis], unit: v.basis, qty: num(v.qty) || 1, unit_price: num(v.rate), sort: 0 }]
      : (r.lines || []).map((l, i) => ({ po_id: po.id, item_key: itemKey(l.name, '', l.unit), description: l.name, spec: '', unit: l.unit, qty: v.q[i] ?? l.qty, unit_price: v.p[i] ?? 0, sort: i }));
    await store.insert('po_lines', pl);
    await store.update('requests', r.id, { route, po_id: po.id, status: 'fulfilling' });
    toast(`${po.number} created`);
  } else {
    const note = await dialog({ title: 'Arranged', body: `<label class="f">What was arranged<input name="n" value="${esc(r.response || '')}" placeholder="e.g. 4 casuals from Monday; Ricky's truck on Thursday"></label>`, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, value: w => w.querySelector('[name=n]').value }] });
    if (note == null) return;
    await store.update('requests', r.id, { route, fulfil_note: note, status: 'on_site' });
    toast('Marked as arranged');
  }
  ctx.reload();
}

// -------------------------------------------------------------- list view
export async function reqList(el, ctx, D) {
  const { store, me } = ctx;
  const limits = await getLimits(store);
  const list = [...D.reqs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const approver = ['admin', 'ops', 'procurement'].includes(me?.role);
  const sup = canStores(me);
  el.innerHTML = `<section class="card"><div class="hd"><h3>Requests from site</h3><span class="small muted">Approved by the Operations Manager or Procurement up to E ${fmt(limits.ops)} / E ${fmt(limits.procurement)}; above that, Matt.</span><span class="grow"></span><button class="btn primary" id="new">+ New request</button></div>
    ${list.length ? `<div class="tbl"><table><thead><tr><th>Date</th><th>Request</th><th class="n">Est. value</th><th>Needed by</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(r => { const u = usedSoFar(r, D.jobcards || []); const chk = approvalCheck(me, r.est_value ?? reqValue(r), limits);
      return `<tr><td class="small">${fmtDate(r.created_at)}<div class="muted">${esc(r.requested_by || '')}</div></td><td><b>${esc(r.description)}</b><div class="small muted">${esc(r.kind)} · ${esc(r.items || '')}</div>
        ${r.route ? `<div class="small">↳ ${esc(ROUTES[r.route] || r.route)}${r.fulfil_note ? ': ' + esc(r.fulfil_note) : ''}${r.approved_by_name ? ` · approved by ${esc(r.approved_by_name)}` : ''}</div>` : r.approved_by_name ? `<div class="small">Approved by ${esc(r.approved_by_name)}</div>` : ''}
        ${['fulfilling', 'on_site', 'complete'].includes(r.status) && (r.lines || []).length ? `<div class="small muted">Used / installed: ${(r.lines || []).map((l, i) => `${fmt(u.used[i])}/${fmt(l.qty)} ${esc(l.unit)} ${esc(l.name)}`).join(', ')}</div>` : ''}${r.po_id && r.route === 'hire' ? `<div class="small muted">Logged on jobcards: ${fmt(u.hire, 1)} ${esc(r.hire?.basis || 'hour')}s</div>` : ''}
        ${r.response ? `<div class="small">“${esc(r.response)}”</div>` : ''}</td>
        <td class="n">${r.est_value ? money(Number(r.est_value), 0) : '–'}</td><td class="small">${r.needed_by ? fmtDate(r.needed_by) : '–'}</td><td>${reqPill(r.status)}${r.status === 'pending' && r.escalated ? '<div class="small flag">Needs Matt</div>' : ''}</td>
        <td class="n" style="white-space:nowrap">${r.status === 'pending' && approver ? (chk.ok ? `<button class="btn small primary" data-dec="approved" data-r="${r.id}">Approve</button> ` : `<span class="small muted" title="${esc(chk.why)}">Over your limit</span> `) + `<button class="btn small" data-dec="declined" data-r="${r.id}">Decline</button>` : ''}
          ${r.status === 'approved' && sup ? `<button class="btn small primary" data-ful="${r.id}">Supply</button>` : ''}${['fulfilling', 'on_site'].includes(r.status) && sup ? `<button class="btn small" data-dec="done" data-r="${r.id}">Close</button>` : ''}${r.po_id ? ` <a class="btn small" href="#/p/${r.project_id}/procure/po/${r.po_id}">PO</a>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`
    : '<div class="empty"><b>No requests</b>Supervisors request materials, tools, plant hire, fuel, labour or transport here or from the daily jobcard.</div>'}</section>`;
  el.querySelector('#new').onclick = async () => { if (await newRequest(ctx, D, {})) ctx.reload(); };
  el.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => decideRequest(ctx, D.reqs.find(r => r.id === b.dataset.r), b.dataset.dec === 'done' ? 'complete' : b.dataset.dec));
  el.querySelectorAll('[data-ful]').forEach(b => b.onclick = () => fulfilRequest(ctx, D.reqs.find(r => r.id === b.dataset.ful)));
}
