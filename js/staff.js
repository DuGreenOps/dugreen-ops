// People register: staff, casual workers and subcontractors who work on site (most are not app users),
// the rates sheet kept by Procurement and the QS/Ops manager, contracts, and transport-rate defaults.
import { esc, fmt, money, dialog, formData, toast, confirmDlg, num, today, fmtDate, addDays, VEHICLES, PERSON_KINDS, PAY_BASIS, WORKDAYS_PER_MONTH, canSetRates, copyText, downloadFile, csvCell } from './util.js';
import { getSetting, setSetting } from './store.js';
import { CONTRACT_TYPES, contractFor, contractBadge, startContract, viewContract, contractState, DEFAULT_SUB_TERMS } from './contracts.js';

export const STAFF_ROLES = ['Site Supervisor', 'Team leader', 'General worker', 'Horticulturist', 'Irrigation tech', 'Driver', 'Plant operator', 'Casual', 'Other'];
export const TRADES = ['Paving', 'Irrigation', 'Earthworks / TLB', 'Fencing', 'Electrical', 'Building / masonry', 'Carpentry / decking', 'Tree felling', 'Grassing', 'Plumbing', 'Other'];

// Day-equivalent cost used for labour costing on jobcards (monthly staff are spread over 26 working days).
export function dayCost(p) {
  if (!p || p.rate == null || p.rate === '') return p?.day_rate != null ? Number(p.day_rate) : null;
  const r = Number(p.rate);
  return { day: r, hour: r * 8, month: r / WORKDAYS_PER_MONTH }[p.pay_basis || 'day'] ?? null;
}
const basisOf = p => p.pay_basis || (p.kind === 'subcontractor' ? 'job' : 'day');

export async function editStaff(store, s, opts = {}) {
  const me = opts.me, rates = canSetRates(me);
  const kind = s?.kind || opts.kind || 'staff';
  const sub = k => k === 'subcontractor';
  const body = k => `
      <label class="f">Type<select name="kind">${Object.entries(PERSON_KINDS).map(([v, l]) => `<option value="${v}" ${k === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${sub(k) ? `<div class="grid2"><label class="f">Company / trading name<input name="name" required value="${esc(s?.name)}"></label><label class="f">Contact person<input name="contact" value="${esc(s?.contact)}"></label></div>
        <div class="grid2"><label class="f">Trade<select name="role">${TRADES.map(r => `<option ${s?.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label><label class="f">Usual crew size<input name="crew_size" inputmode="numeric" value="${s?.crew_size ?? ''}"></label></div>
        <div class="grid2"><label class="f">Company reg. / ID no.<input name="id_no" value="${esc(s?.id_no)}"></label><label class="f">Email<input name="email" type="email" value="${esc(s?.email)}"></label></div>`
      : `<label class="f">Full name<input name="name" required value="${esc(s?.name)}"></label>
        <div class="grid2"><label class="f">Role<select name="role">${STAFF_ROLES.map(r => `<option ${(s?.role || (k === 'casual' ? 'Casual' : '')) === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label><label class="f">ID / passport no.<input name="id_no" value="${esc(s?.id_no)}"></label></div>`}
      <div class="grid2"><label class="f">Phone / WhatsApp<input name="phone" type="tel" value="${esc(s?.phone)}" placeholder="+268 …"></label>
        ${sub(k) ? `<label class="f">Address<input name="address" value="${esc(s?.address)}"></label>` : `<label class="f">App login email (supervisors)<input name="user_email" type="email" value="${esc(s?.user_email)}" placeholder="optional"></label>`}</div>
      ${rates ? `<div class="dims"><b style="font-family:var(--display)">Rate</b> <span class="small muted">· only Procurement, the QS and Matt see and change this</span>
        <div class="grid2"><label class="f">Paid by<select name="pay_basis">${Object.entries(PAY_BASIS).map(([v, l]) => `<option value="${v}" ${basisOf({ ...s, kind: k }) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="f">Rate / fee (E)<input name="rate" inputmode="decimal" value="${s?.rate ?? s?.day_rate ?? ''}"></label></div></div>` : '<p class="small muted">Procurement or the QS will add the rate in the rates sheet.</p>'}
      <label class="chk"><input type="checkbox" name="active" ${s?.active === false ? '' : 'checked'}> Currently working for Du Green</label>
      <label class="f">Notes<textarea name="notes">${esc(s?.notes)}</textarea></label>`;
  const v = await dialog({
    title: s ? s.name : sub(kind) ? 'Add subcontractor' : 'Add person', sticky: true, body: `<div id="pf">${body(kind)}</div>`,
    onOpen: w => { const wire = () => { w.querySelector('[name=kind]').onchange = e => { const keep = formData(w); w.querySelector('#pf').innerHTML = body(e.target.value); for (const [k, val] of Object.entries(keep)) { const i = w.querySelector(`#pf [name=${k}]`); if (i && i.type !== 'checkbox' && k !== 'kind' && k !== 'role') i.value = val; } wire(); }; }; wire(); },
    buttons: [...(s ? [{ label: 'Delete', danger: true, value: 'delete' }] : []), { label: 'Cancel', value: null }, { label: 'Save', primary: true, value: w => formData(w), validate: w => !!w.querySelector('[name=name]').value.trim() }],
  });
  if (!v) return null;
  if (v === 'delete') { if (await confirmDlg('Delete from the register?', s.name)) { await store.remove('staff', s.id); return 'deleted'; } return null; }
  const row = { name: v.name.trim(), kind: v.kind, role: v.role, phone: v.phone || null, id_no: v.id_no || null, active: !!v.active, notes: v.notes || null,
    contact: v.contact || null, email: v.email || null, address: v.address || null, crew_size: num(v.crew_size), user_email: (v.user_email || '').trim().toLowerCase() || s?.user_email || null };
  if (rates) Object.assign(row, rateFields(v.pay_basis, num(v.rate), me));
  const out = s ? await store.update('staff', s.id, row) : await store.insert('staff', row);
  toast('Saved'); return out;
}
function rateFields(pay_basis, rate, me) {
  const p = { pay_basis, rate };
  return { ...p, day_rate: dayCost(p), rate_updated_at: new Date().toISOString(), rate_updated_by: me?.full_name || me?.email || null };
}

// ----------------------------------------------------------------- page
async function loadPeople(store) {
  const [people, contracts, jobcards, projects] = await Promise.all([store.list('staff', {}, 'name'), store.list('contracts', {}, null), store.list('jobcards', {}, 'card_date'), store.list('projects', {}, null)]);
  const projBy = Object.fromEntries(projects.map(p => [p.id, p]));
  // Days on site per person (from submitted jobcards), and where they were last seen.
  const seen = {};
  const add = (id, j, days) => { const s = seen[id] = seen[id] || { days: 0, last: null, lastProject: null, byProject: {}, dates: [] }; s.days += days; s.dates.push({ d: j.card_date, days, p: j.project_id }); s.byProject[j.project_id] = (s.byProject[j.project_id] || 0) + days; if (!s.last || j.card_date >= s.last) { s.last = j.card_date; s.lastProject = j.project_id; } };
  for (const j of jobcards.filter(j => j.status !== 'draft')) {
    for (const s of j.staff || []) if (s.staff_id) add(s.staff_id, j, (Number(s.hours) || 8) / 8);
    for (const s of j.subbies || []) if (s.person_id) add(s.person_id, j, (Number(s.crew) || 1) * (Number(s.hours) || 8) / 8);
  }
  return { people, contracts, jobcards, projects, projBy, seen };
}

export async function render(app, ctx, rest = []) {
  const { store, me } = ctx;
  const tab = rest[0] || 'register';
  const P = await loadPeople(store);
  const rates = canSetRates(me);
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">People on site</div><h1>People & subcontractors</h1>
      <p class="small muted" style="margin:4px 0 0">Supervisors book people onto the daily jobcard and get contracts signed on site. Procurement and the QS keep the rates.</p></div>
      <div class="row"><button class="btn" id="addsub">+ Subcontractor</button><button class="btn primary" id="add">+ Person</button></div></div>
    <nav class="subtabs"><a href="#/people" class="${tab === 'register' ? 'on' : ''}">Register</a><a href="#/people/rates" class="${tab === 'rates' ? 'on' : ''}">Rates sheet</a><a href="#/people/contracts" class="${tab === 'contracts' ? 'on' : ''}">Contracts</a></nav>
    <div id="pv"></div></div>`;
  app.querySelector('#add').onclick = async () => { if (await editStaff(store, null, { me })) ctx.reload(); };
  app.querySelector('#addsub').onclick = async () => { if (await editStaff(store, null, { me, kind: 'subcontractor' })) ctx.reload(); };
  const el = app.querySelector('#pv');
  if (tab === 'rates') return ratesView(el, ctx, P, rates);
  if (tab === 'contracts') return contractsView(el, ctx, P);
  return registerView(el, ctx, P);
}

function registerView(el, ctx, P) {
  const { store, me } = ctx;
  let filter = 'all', q = '';
  const draw = () => {
    const list = P.people.filter(p => (filter === 'all' || (p.kind || 'staff') === filter) && (!q || `${p.name} ${p.role} ${p.company || ''} ${p.phone || ''}`.toLowerCase().includes(q)));
    el.innerHTML = `<div class="row" style="margin:10px 0">${[['all', 'Everyone'], ...Object.entries(PERSON_KINDS)].map(([k, l]) => `<button class="btn small ${filter === k ? 'primary' : ''}" data-f="${k}">${l} <span class="muted">${k === 'all' ? P.people.length : P.people.filter(p => (p.kind || 'staff') === k).length}</span></button>`).join('')}
        <input id="q" placeholder="Search name, trade, phone" value="${esc(q)}" style="max-width:240px;margin-left:auto"></div>
      <section class="card">${list.length ? `<div class="tbl"><table><thead><tr><th>Name</th><th>Type</th><th>Role / trade</th><th>Phone</th><th>Contract</th><th>Last on site</th><th>Status</th></tr></thead><tbody>
        ${list.map(p => { const r = contractFor(p.id, P.contracts, null), s = P.seen[p.id]; return `<tr class="click" data-s="${p.id}"><td><b>${esc(p.name)}</b>${p.contact ? `<div class="small muted">${esc(p.contact)}</div>` : ''}</td><td class="small">${esc(PERSON_KINDS[p.kind || 'staff'])}</td><td>${esc(p.role || '')}</td><td class="small">${esc(p.phone || '')}</td>
          <td>${contractBadge(r)}</td><td class="small">${s ? `${fmtDate(s.last)}<div class="muted">${esc(P.projBy[s.lastProject]?.name || '')}</div>` : '–'}</td><td>${p.active === false ? '<span class="pill mute">Inactive</span>' : '<span class="pill ok">Active</span>'}</td></tr>`; }).join('')}
        </tbody></table></div>` : '<div class="empty"><b>Nobody here yet</b>Add your supervisors, workers, casuals and subcontractors so they can be booked onto jobcards and sign contracts.</div>'}</section>`;
    el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filter = b.dataset.f; draw(); });
    const qi = el.querySelector('#q'); qi.oninput = () => { q = qi.value.toLowerCase(); const pos = qi.selectionStart; draw(); const n = el.querySelector('#q'); n.focus(); n.setSelectionRange(pos, pos); };
    el.querySelectorAll('[data-s]').forEach(r => r.onclick = () => personCard(ctx, P.people.find(p => p.id === r.dataset.s), P));
  };
  draw();
}

// One person: details, contracts, days on site.
export async function personCard(ctx, p, P, project = null) {
  const { store, me } = ctx;
  const mine = P.contracts.filter(c => c.person_id === p.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const s = P.seen?.[p.id];
  const v = await dialog({
    title: p.name, wide: true,
    body: `<div class="row"><span class="pill info">${esc(PERSON_KINDS[p.kind || 'staff'])}</span><span>${esc(p.role || '')}</span>${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : ''}<span class="grow"></span>${contractBadge(contractFor(p.id, P.contracts, project?.id))}</div>
      ${canSetRates(me) ? `<p class="small">Rate: <b>${p.rate != null ? money(Number(p.rate)) : 'not set'}</b> ${esc(PAY_BASIS[basisOf(p)] || '')}${p.rate_updated_by ? ` <span class="muted">· set by ${esc(p.rate_updated_by)} ${fmtDate(p.rate_updated_at)}</span>` : ''}</p>` : ''}
      ${s ? `<p class="small muted">${fmt(s.days, 1)} ${p.kind === 'subcontractor' ? 'person-' : ''}days on site · last ${fmtDate(s.last)}</p>` : ''}
      <h3 style="margin:12px 0 4px;font-size:15px">Contracts</h3>
      ${mine.length ? `<div class="tbl"><table><thead><tr><th>No.</th><th>Type</th><th>Project</th><th>Dates</th><th>Status</th></tr></thead><tbody>${mine.map(c => { const st = contractState(c); return `<tr class="click" data-c="${c.id}"><td><b>${esc(c.number)}</b></td><td class="small">${esc(CONTRACT_TYPES[c.type]?.short || c.type)}</td><td class="small">${esc(P.projBy?.[c.project_id]?.name || 'All projects')}</td><td class="small">${c.start_date ? fmtDate(c.start_date) : ''}${c.end_date ? ' – ' + fmtDate(c.end_date) : ''}</td>
        <td>${st === 'signed' ? '<span class="pill ok">Signed</span>' : st === 'expired' ? '<span class="pill bad">Expired</span>' : st === 'void' ? '<span class="pill mute">Cancelled</span>' : '<span class="pill warn">Draft</span>'}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted small">No contract yet.</p>'}`,
    onOpen: w => w.querySelectorAll('[data-c]').forEach(r => r.onclick = async () => { const c = mine.find(x => x.id === r.dataset.c); w.querySelector('[data-x]').click(); const res = await viewContract(ctx, c, p, P.projBy?.[c.project_id] || project); if (res) ctx.reload(); }),
    buttons: [{ label: 'Edit details', value: 'edit' }, { label: 'New contract', primary: true, value: 'contract' }],
  });
  if (v === 'edit') { if (await editStaff(store, p, { me })) ctx.reload(); }
  if (v === 'contract') { const areas = project ? await store.list('areas', { project_id: project.id }) : []; if (await startContract(ctx, { person: p, project, areas })) ctx.reload(); }
}

// ------------------------------------------------------------- rates sheet
// Pay period follows the casual contracts: work tickets close on the 25th.
export function payPeriod(on = today()) {
  const [y, m, d] = on.split('-').map(Number);
  const end = d > 25 ? new Date(Date.UTC(y, m, 25)) : new Date(Date.UTC(y, m - 1, 25));
  const start = new Date(end); start.setUTCMonth(start.getUTCMonth() - 1); start.setUTCDate(26);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function ratesView(el, ctx, P, canEdit) {
  const { store, me } = ctx;
  let per = payPeriod(), kind = 'all';
  const draw = () => {
    const rows = P.people.filter(p => p.active !== false && (kind === 'all' || (p.kind || 'staff') === kind)).map(p => {
      const r = contractFor(p.id, P.contracts, null), s = P.seen[p.id];
      const days = s ? s.dates.filter(x => x.d >= per.from && x.d <= per.to).reduce((t, x) => t + x.days, 0) : 0;
      const projects = s ? Object.keys(s.byProject).map(id => P.projBy[id]?.name).filter(Boolean) : [];
      const b = basisOf(p), rate = p.rate ?? (b === 'day' ? p.day_rate : null);
      const due = rate == null ? null : b === 'day' ? days * rate : b === 'hour' ? days * 8 * rate : b === 'month' ? Number(rate) : null;
      return { p, r, days, projects, b, rate, due };
    });
    const missing = rows.filter(x => x.rate == null).length, noContract = rows.filter(x => !x.r.ok).length;
    el.innerHTML = `${canEdit ? '' : '<div class="note">Only Procurement, the QS / Ops manager and Matt can change rates. You can see who has a contract in place.</div>'}
      <div class="row" style="margin:10px 0;gap:8px">
        ${[['all', 'Everyone'], ...Object.entries(PERSON_KINDS)].map(([k, l]) => `<button class="btn small ${kind === k ? 'primary' : ''}" data-k="${k}">${l}</button>`).join('')}
        <span class="grow"></span><label class="small">Pay period <input type="date" id="pf" value="${per.from}" style="width:auto"> – <input type="date" id="pt" value="${per.to}" style="width:auto"></label></div>
      ${missing || noContract ? `<div class="note warn">${missing ? `<b>${missing}</b> without a rate. ` : ''}${noContract ? `<b>${noContract}</b> without a signed contract in place.` : ''}</div>` : ''}
      <section class="card"><div class="tbl"><table class="sheet"><thead><tr><th>Name</th><th>Type</th><th>Role / trade</th><th>Projects</th><th>Paid by</th><th class="n">Rate / fee (E)</th><th>Contract in place</th><th class="n">Days in period</th><th class="n">Est. pay (E)</th><th>Rate set by</th></tr></thead><tbody>
        ${rows.map(x => `<tr data-p="${x.p.id}"><td><b>${esc(x.p.name)}</b>${x.p.id_no ? `<div class="small muted">ID ${esc(x.p.id_no)}</div>` : ''}</td><td class="small">${esc(PERSON_KINDS[x.p.kind || 'staff'])}</td><td class="small">${esc(x.p.role || '')}</td><td class="small">${esc(x.projects.join(', '))}</td>
          <td>${canEdit ? `<select data-f="pay_basis">${Object.entries(PAY_BASIS).map(([v, l]) => `<option value="${v}" ${x.b === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : esc(PAY_BASIS[x.b])}</td>
          <td class="n">${canEdit ? `<input class="num" style="width:100px" data-f="rate" inputmode="decimal" value="${x.rate ?? ''}">` : x.rate != null ? '•••' : '–'}</td>
          <td>${x.r.ok ? `<span class="pill ok">Yes</span> <span class="small muted">${esc(CONTRACT_TYPES[x.r.c.type]?.short || '')}</span>` : `<span class="pill bad">No</span>${x.r.state !== 'none' ? ` <span class="small muted">${x.r.state}</span>` : ''}`}</td>
          <td class="n">${fmt(x.days, 1)}</td><td class="n">${canEdit && x.due != null ? fmt(x.due, 2) : x.b === 'job' || x.b === 'rate' ? '<span class="small muted">per cert</span>' : '–'}</td>
          <td class="small muted">${esc(x.p.rate_updated_by || '')}${x.p.rate_updated_at ? '<br>' + fmtDate(x.p.rate_updated_at) : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="padding:10px 14px;flex-wrap:wrap"><span class="small muted" style="flex:1 1 260px">Changes save as you go. Subcontractors on a job fee or measured rates are paid through subcontractor certificates.</span>
        <button class="btn small" id="cp">Copy for Google Sheets</button><button class="btn small" id="csv">Download CSV</button></div></section>`;
    el.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { kind = b.dataset.k; draw(); });
    el.querySelector('#pf').onchange = e => { per.from = e.target.value; draw(); };
    el.querySelector('#pt').onchange = e => { per.to = e.target.value; draw(); };
    if (canEdit) el.querySelectorAll('tr[data-p] [data-f]').forEach(i => i.onchange = async () => {
      const tr = i.closest('tr'), p = P.people.find(x => x.id === tr.dataset.p);
      const patch = rateFields(tr.querySelector('[data-f=pay_basis]').value, num(tr.querySelector('[data-f=rate]').value), me);
      Object.assign(p, await store.update('staff', p.id, patch)); toast(`Rate saved for ${p.name}`); draw();
    });
    const table = () => [['Name', 'ID / reg no.', 'Type', 'Role / trade', 'Phone', 'Projects', 'Paid by', 'Rate / fee (E)', 'Contract in place', 'Contract type', 'Contract no.', 'Contract ends', `Days ${per.from} to ${per.to}`, 'Est. pay (E)'],
      ...rows.map(x => [x.p.name, x.p.id_no || '', PERSON_KINDS[x.p.kind || 'staff'], x.p.role || '', x.p.phone || '', x.projects.join('; '), PAY_BASIS[x.b], canEdit && x.rate != null ? Number(x.rate).toFixed(2) : '', x.r.ok ? 'Yes' : 'No', x.r.c ? CONTRACT_TYPES[x.r.c.type]?.short : '', x.r.c?.number || '', x.r.c?.end_date || '', x.days.toFixed(1), canEdit && x.due != null ? x.due.toFixed(2) : ''])];
    el.querySelector('#cp').onclick = async () => (await copyText(table().map(r => r.join('\t')).join('\n'))) ? toast('Copied – paste into Google Sheets') : toast('Copy failed');
    el.querySelector('#csv').onclick = () => downloadFile(`DuGreen_rates_sheet_${per.to}.csv`, '﻿' + table().map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv');
  };
  draw();
}

// ---------------------------------------------------------------- contracts
function contractsView(el, ctx, P) {
  const since = addDays(today(), -30);
  const needs = P.people.filter(p => p.active !== false && P.seen[p.id]?.last >= since && !contractFor(p.id, P.contracts, null).ok);
  const list = [...P.contracts].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const personBy = Object.fromEntries(P.people.map(p => [p.id, p]));
  el.innerHTML = `${needs.length ? `<section class="card"><div class="hd"><h3>On site without a contract</h3><span class="pill bad">${needs.length}</span><span class="small muted">worked in the last 30 days</span></div>
      <div class="tbl"><table><tbody>${needs.map(p => `<tr><td><b>${esc(p.name)}</b> <span class="small muted">${esc(PERSON_KINDS[p.kind || 'staff'])} · ${esc(p.role || '')}</span></td><td class="small">${esc(P.projBy[P.seen[p.id].lastProject]?.name || '')}</td><td class="n"><button class="btn small primary" data-new="${p.id}">Sign contract</button></td></tr>`).join('')}</tbody></table></div></section>` : ''}
    <section class="card"><div class="hd"><h3>All contracts</h3><span class="small muted">${list.filter(c => contractState(c) === 'signed').length} in place</span><span class="grow"></span>
      <a class="btn small" href="#/settings">Standard subcontract terms</a></div>
      ${list.length ? `<div class="tbl"><table><thead><tr><th>No.</th><th>Person</th><th>Type</th><th>Project</th><th>Dates</th><th>Status</th></tr></thead><tbody>${list.map(c => { const st = contractState(c), p = personBy[c.person_id]; return `<tr class="click" data-c="${c.id}"><td><b>${esc(c.number)}</b></td><td>${esc(p?.name || '(removed)')}</td><td class="small">${esc(CONTRACT_TYPES[c.type]?.short || c.type)}</td><td class="small">${esc(P.projBy[c.project_id]?.name || 'All projects')}</td>
        <td class="small">${c.start_date ? fmtDate(c.start_date) : ''}${c.end_date ? ' – ' + fmtDate(c.end_date) : ''}</td><td>${st === 'signed' ? '<span class="pill ok">Signed</span>' : st === 'expired' ? '<span class="pill bad">Expired</span>' : st === 'void' ? '<span class="pill mute">Cancelled</span>' : '<span class="pill warn">Draft</span>'}${c.type !== 'subcontract' && c.type !== 'upload' && st === 'signed' && !c.id_photo ? ' <span class="pill warn">ID outstanding</span>' : ''}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="empty small">No contracts yet. Open a person in the register, or use “Sign contract” from the daily jobcard.</div>'}</section>`;
  el.querySelectorAll('[data-new]').forEach(b => b.onclick = async () => { const p = personBy[b.dataset.new]; const proj = P.projBy[P.seen[p.id].lastProject]; const areas = proj ? await ctx.store.list('areas', { project_id: proj.id }) : []; if (await startContract(ctx, { person: p, project: proj, areas })) ctx.reload(); });
  el.querySelectorAll('[data-c]').forEach(r => r.onclick = async () => { const c = P.contracts.find(x => x.id === r.dataset.c); if (await viewContract(ctx, c, personBy[c.person_id] || { name: '?' }, P.projBy[c.project_id])) ctx.reload(); });
}

export async function renderSubTermsSettings(el, store, canEdit) {
  const v = await getSetting(store, 'subcontract_terms', DEFAULT_SUB_TERMS) || DEFAULT_SUB_TERMS;
  el.innerHTML = `<div class="bd stack"><p class="small muted">These terms are copied into each new subcontract agreement. Supervisors and the QS can still change them for one subbie. They are a starting draft based on the group's usual subcontract terms (pay-when-paid, 10% retention capped at 5%, Eswatini law). Have them checked before relying on them.</p>
    <textarea id="stt" rows="16" style="font:12px/1.4 var(--body)" ${canEdit ? '' : 'disabled'}>${esc(v)}</textarea>
    ${canEdit ? '<div class="row"><button class="btn small" id="str">Reset to the standard draft</button><span class="grow"></span><button class="btn small primary" id="sts">Save terms</button></div>' : ''}</div>`;
  if (!canEdit) return;
  el.querySelector('#sts').onclick = async () => { await setSetting(store, 'subcontract_terms', el.querySelector('#stt').value); toast('Subcontract terms saved'); };
  el.querySelector('#str').onclick = () => { el.querySelector('#stt').value = DEFAULT_SUB_TERMS; };
}

export async function renderVehicleSettings(el, store, canEdit) {
  const vs = await getSetting(store, 'vehicles', VEHICLES) || VEHICLES;
  el.innerHTML = `<div class="tbl"><table><thead><tr><th>Vehicle</th><th>Charged per</th><th class="n">Carries (m³)</th><th class="n">Default cost (E)</th></tr></thead><tbody>
    ${vs.map((v, i) => `<tr><td><input data-i="${i}" data-k="key" value="${esc(v.key)}" ${canEdit ? '' : 'disabled'}></td>
      <td><select data-i="${i}" data-k="basis" ${canEdit ? '' : 'disabled'}><option value="load" ${v.basis !== 'trip' ? 'selected' : ''}>Load</option><option value="trip" ${v.basis === 'trip' ? 'selected' : ''}>Trip</option></select></td>
      <td class="n"><input class="num" data-i="${i}" data-k="capacity_m3" inputmode="decimal" value="${v.capacity_m3 ?? ''}" ${canEdit ? '' : 'disabled'}></td>
      <td class="n"><input class="num" data-i="${i}" data-k="cost" inputmode="decimal" value="${v.cost ?? ''}" ${canEdit ? '' : 'disabled'}></td></tr>`).join('')}
    </tbody></table></div>
    ${canEdit ? '<div class="row" style="padding:10px 14px"><button class="btn small" id="vadd">+ Vehicle</button><span class="grow"></span><button class="btn small primary" id="vsave">Save transport rates</button></div>' : ''}`;
  if (!canEdit) return;
  const read = () => { const out = vs.map(v => ({ ...v })); el.querySelectorAll('[data-i]').forEach(i => { const o = out[+i.dataset.i]; o[i.dataset.k] = ['capacity_m3', 'cost'].includes(i.dataset.k) ? num(i.value) : i.value; }); return out.filter(v => v.key && v.key.trim()); };
  el.querySelector('#vadd').onclick = () => { vs.splice(0, vs.length, ...read(), { key: 'New vehicle', basis: 'load', capacity_m3: null, cost: null }); renderVehicleSettings(el, store, canEdit).then(() => {}); setSetting(store, 'vehicles', vs); };
  el.querySelector('#vsave').onclick = async () => { await setSetting(store, 'vehicles', read()); toast('Transport rates saved'); };
}

export { loadPeople };
