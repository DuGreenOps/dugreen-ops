// Payment certificates.
// Client IPCs: BOQ selling value × % complete (from the programme, which the daily jobcards update), plus approved
// site instructions, less retention and previous certificates. Every % and value can be amended before issuing.
// Subcontractor certificates: work done (from jobcards and progress) × the agreed price, less retention
// (normally 10% capped at 5% of the subcontract sum) and previous certificates, paid when Du Green is paid.
import { esc, fmt, money, dialog, formData, toast, confirmDlg, num, today, fmtDate, addDays, groupBy, canSetRates } from './util.js';
import { loadProcurement } from './procure.js';
import { progress } from './pow.js';
import { sortAreas } from './areas.js';
import { head, open } from './docs.js';
import { SUB_BASIS } from './contracts.js';

export const IPC_STATUS = { draft: 'Draft', issued: 'Issued to client', certified: 'Certified by client', paid: 'Paid' };
export const SUBC_STATUS = { draft: 'Draft', approved: 'Approved', paid: 'Paid' };
const ipcPill = s => `<span class="pill ${{ draft: 'warn', issued: 'info', certified: 'info', paid: 'ok' }[s] || 'mute'}">${esc(IPC_STATUS[s] || s)}</span>`;
const subPill = s => `<span class="pill ${{ draft: 'warn', approved: 'info', paid: 'ok' }[s] || 'mute'}">${esc(SUBC_STATUS[s] || s)}</span>`;
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

async function load(store, project) {
  const [D, costRows, tasks, sis, claims, jobcards, contracts, subCerts, staff] = await Promise.all([
    loadProcurement(store, project), store.list('costing', { project_id: project.id }, null), store.list('tasks', { project_id: project.id }, null),
    store.list('site_instructions', { project_id: project.id }), store.list('claims', { project_id: project.id }, 'claim_date'),
    store.list('jobcards', { project_id: project.id }, 'card_date'), store.list('contracts', { project_id: project.id }, null),
    store.list('sub_certs', { project_id: project.id }, 'cert_date'), store.list('staff', {}, 'name')]);
  const cost = Object.fromEntries(costRows.map(c => [c.item_key, c]));
  const areas = sortAreas(D.areas), areaBy = Object.fromEntries(areas.map(a => [a.id, a]));
  const overall = progress(tasks);
  const areaPct = id => { const ts = tasks.filter(t => t.area_id === id); return ts.length ? progress(ts) : null; };
  const sell = i => {
    const c = cost[i.item_key] || {}, s = D.selBy[i.item_key];
    const cr = c.cost_override != null ? Number(c.cost_override) : s ? Number(s.unit_price) : i.unit_cost != null ? Number(i.unit_cost) : null;
    return c.sell_override != null ? Number(c.sell_override) : cr != null && c.markup_pct != null ? Math.round(cr * (1 + Number(c.markup_pct) / 100) * 100) / 100 : null;
  };
  return { D, areas, areaBy, tasks, sis, claims, jobcards, contracts, subCerts, staff, staffBy: Object.fromEntries(staff.map(s => [s.id, s])), overall, areaPct, sell };
}

// Current valuation lines (BOQ by area + variations), with % complete from the programme.
function clientLines(C) {
  const out = [];
  for (const i of C.D.items) {
    const rate = C.sell(i);
    for (const l of i.lines.length ? i.lines : [{ area: null, qty_calc: i.qty }]) {
      const ap = l.area ? C.areaPct(l.area.id) : null;
      out.push({ key: `${i.item_key}|${l.area?.id || ''}`, group: l.area ? `${l.area.code || ''} ${l.area.name || ''}`.trim() : 'Site-wide', area_id: l.area?.id || null, description: i.description, spec: i.spec || '', unit: i.unit, qty: r2(l.qty_calc), rate, value: rate != null ? r2(rate * l.qty_calc) : 0, pct_auto: Math.round((ap ?? C.overall) * 1000) / 10, source: ap != null ? 'area programme' : 'overall progress' });
    }
  }
  // Merge duplicates (same item listed twice in one area)
  const m = {}; for (const l of out) { if (m[l.key]) { m[l.key].qty = r2(m[l.key].qty + l.qty); m[l.key].value = r2(m[l.key].value + l.value); } else m[l.key] = l; }
  const lines = Object.values(m);
  for (const s of C.sis.filter(s => s.cost_impact && ['approved', 'done'].includes(s.status))) {
    const ap = s.area_id ? C.areaPct(s.area_id) : null;
    lines.push({ key: 'si|' + s.id, group: 'Variations (site instructions)', area_id: s.area_id, description: `${s.number}: ${s.description}`, unit: 'item', qty: 1, rate: Number(s.est_value) || 0, value: Number(s.est_value) || 0, pct_auto: s.status === 'done' ? 100 : Math.round((ap ?? 0) * 1000) / 10, source: s.status === 'done' ? 'SI completed' : ap != null ? 'area programme' : 'not started', variation: true });
  }
  return lines;
}

// Totals for one certificate (pure, so the editor and the document agree).
export function ipcTotals(c, prevCerts) {
  const gross = r2((c.lines || []).reduce((t, l) => t + (l.value_override != null ? Number(l.value_override) : (Number(l.value) || 0) * (Number(l.pct) || 0) / 100), 0));
  const contract = r2((c.lines || []).reduce((t, l) => t + (Number(l.value) || 0), 0));
  const capAmt = (Number(c.retention_cap ?? 5) / 100) * contract;
  const retention = r2(Math.min(gross * Number(c.retention_pct ?? 10) / 100, capAmt || Infinity));
  const prev = r2(prevCerts.reduce((t, p) => Math.max(t, Number(p.net_to_date) || 0), 0));
  const net = r2(gross - retention), due = r2(net - prev), vat = r2(due * Number(c.vat_rate ?? 0.15));
  return { gross, contract, retention, prev, net, due, vat, total: r2(due + vat), pct: contract ? gross / contract : 0 };
}

export async function render(root, ctx) {
  const { store, project } = ctx;
  const [sub = 'client', arg] = ctx.rest || [];
  const C = await load(store, project);
  root.innerHTML = `<div class="page">
    <div class="row"><div class="grow"><div class="eyebrow">QS · Matt</div><h2 style="font-size:24px">Certificates</h2>
      <p class="small muted" style="margin:2px 0 0">Progress comes from the daily jobcards through the programme. Amend any line before you issue.</p></div>
      <nav class="subtabs"><a href="#/p/${project.id}/certs" class="${sub === 'client' || sub === 'ipc' ? 'on' : ''}">Client certificates</a><a href="#/p/${project.id}/certs/sub" class="${sub === 'sub' || sub === 'subc' ? 'on' : ''}">Subcontractor certificates</a></nav></div>
    <div id="cv"></div></div>`;
  const el = root.querySelector('#cv');
  if (sub === 'ipc') return ipcEditor(el, ctx, C, arg);
  if (sub === 'subc') return subEditor(el, ctx, C, arg);
  if (sub === 'sub') return subList(el, ctx, C);
  return ipcList(el, ctx, C);
}

// ------------------------------------------------------------ client IPCs
function ipcList(el, ctx, C) {
  const { project } = ctx;
  const certs = [...C.claims].sort((a, b) => String(a.claim_date).localeCompare(String(b.claim_date)));
  const lines = clientLines(C), contract = lines.reduce((t, l) => t + l.value, 0);
  const last = certs[certs.length - 1];
  const paid = certs.reduce((t, c) => t + (Number(c.paid) || 0), 0), certified = certs.reduce((t, c) => t + (Number(c.certified) || 0), 0);
  el.innerHTML = `<div class="kpis">
      <div class="kpi"><div class="k">Contract + variations</div><div class="v">${money(contract, 0)}</div></div>
      <div class="kpi"><div class="k">Work done (programme)</div><div class="v">${fmt(C.overall * 100)}%</div></div>
      <div class="kpi"><div class="k">Certified to date</div><div class="v">${money(certified, 0)}</div><div class="small muted">excl. VAT</div></div>
      <div class="kpi"><div class="k">Paid</div><div class="v">${money(paid, 0)}</div><div class="small muted">outstanding ${money(certified - paid, 0)}</div></div></div>
    ${lines.some(l => l.rate == null) ? `<div class="note warn">${lines.filter(l => l.rate == null).length} BOQ lines have no selling rate, so they can't be valued. Set mark-ups in Costing & BOQ.</div>` : ''}
    <section class="card"><div class="hd"><h3>Interim payment certificates</h3><span class="grow"></span><a class="btn primary" href="#/p/${project.id}/certs/ipc/new">+ New certificate from jobcards</a></div>
      ${certs.length ? `<div class="tbl"><table><thead><tr><th>Cert</th><th>Period to</th><th class="n">Value to date</th><th class="n">This cert excl. VAT</th><th class="n">Certified</th><th class="n">Paid</th><th>Status</th></tr></thead><tbody>
        ${certs.map(c => `<tr class="click" data-c="${c.id}"><td><b>${esc(c.number)}</b><div class="small muted">${fmtDate(c.claim_date)}</div></td><td>${fmtDate(c.period_to)}</td><td class="n">${fmt(c.gross_to_date, 2)}</td><td class="n">${fmt(c.claimed, 2)}</td><td class="n">${c.certified != null ? fmt(c.certified, 2) : '–'}</td><td class="n">${c.paid ? fmt(c.paid, 2) : '–'}</td><td>${ipcPill(c.status || 'draft')}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty"><b>No certificates yet</b>A new certificate is filled in from the programme progress that the supervisors report on their jobcards. You can change any line.</div>'}</section>`;
  el.querySelectorAll('[data-c]').forEach(r => r.onclick = () => ctx.go(`#/p/${project.id}/certs/ipc/${r.dataset.c}`));
}

async function ipcEditor(el, ctx, C, id) {
  const { store, project, me } = ctx;
  const all = [...C.claims].sort((a, b) => String(a.claim_date).localeCompare(String(b.claim_date)));
  let cert = id && id !== 'new' ? all.find(c => c.id === id) : null;
  const prevCerts = all.filter(c => c !== cert && (!cert || String(c.claim_date) <= String(cert.claim_date)) && c.id !== cert?.id);
  const prior = prevCerts[prevCerts.length - 1];
  const fresh = clientLines(C);
  const canEdit = !cert || ['draft'].includes(cert.status || 'draft');
  const admin = ['admin', 'qs'].includes(me?.role);
  let c;
  if (cert) c = JSON.parse(JSON.stringify(cert));
  else {
    const prevPct = Object.fromEntries((prior?.lines || []).map(l => [l.key, Number(l.pct) || 0]));
    c = { number: `IPC-${String(all.length + 1).padStart(2, '0')}`, claim_date: today(), period_from: prior?.period_to ? addDays(prior.period_to, 1) : (C.jobcards[0]?.card_date || today()), period_to: today(),
      retention_pct: prior?.retention_pct ?? 10, retention_cap: prior?.retention_cap ?? 5, vat_rate: Number(project.vat_rate ?? 0.15), status: 'draft',
      lines: fresh.map(l => ({ ...l, prev_pct: prevPct[l.key] ?? 0, pct: Math.max(prevPct[l.key] ?? 0, l.pct_auto) })) };
  }
  const jcIn = () => C.jobcards.filter(j => j.status !== 'draft' && j.card_date >= c.period_from && j.card_date <= c.period_to);
  const draw = () => {
    const T = ipcTotals(c, prevCerts);
    const groups = groupBy(c.lines, l => l.group);
    const dis = canEdit ? '' : 'disabled';
    const jcs = jcIn();
    el.innerHTML = `<section class="card"><div class="hd"><div class="grow"><div class="small muted"><a href="#/p/${project.id}/certs">Certificates</a> /</div><h3>${esc(c.number)} · ${esc(project.name)}</h3></div>${ipcPill(c.status)}
        ${canEdit ? '<button class="btn" id="refresh">Refresh from jobcards</button>' : ''}<button class="btn" id="print">Print / PDF</button></div>
      <div class="bd grid3"><label class="f">Certificate no.<input name="number" value="${esc(c.number)}" ${dis}></label><label class="f">Period from<input type="date" name="period_from" value="${esc(c.period_from)}" ${dis}></label><label class="f">Period to<input type="date" name="period_to" value="${esc(c.period_to)}" ${dis}></label>
        <label class="f">Retention %<input name="retention_pct" inputmode="decimal" value="${c.retention_pct}" ${dis}></label><label class="f">Retention cap (% of contract)<input name="retention_cap" inputmode="decimal" value="${c.retention_cap}" ${dis}></label><label class="f">Date<input type="date" name="claim_date" value="${esc(c.claim_date)}" ${dis}></label></div></section>
    <div class="kpis">
      <div class="kpi"><div class="k">Value to date</div><div class="v">${money(T.gross, 0)}</div><div class="small muted">${fmt(T.pct * 100, 1)}% of ${money(T.contract, 0)}</div></div>
      <div class="kpi"><div class="k">Less retention</div><div class="v">${money(T.retention, 0)}</div><div class="small muted">less previous ${money(T.prev, 0)}</div></div>
      <div class="kpi"><div class="k">This certificate excl. VAT</div><div class="v">${money(T.due, 2)}</div></div>
      <div class="kpi"><div class="k">Incl. VAT ${fmt(c.vat_rate * 100)}%</div><div class="v">${money(T.total, 2)}</div></div></div>
    <section class="card"><div class="hd"><h3>Valuation</h3><span class="small muted">% complete starts from the programme (updated by jobcards). Type a % or a value to amend; amended lines show ✎.</span></div>
      <div class="tbl"><table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th><th class="n">Previous %</th><th class="n">Programme %</th><th class="n">% to date</th><th class="n">Value to date</th></tr></thead><tbody>
      ${Object.entries(groups).map(([g, ls]) => `<tr class="sec"><td colspan="8"><b>${esc(g)}</b></td></tr>` + ls.map(l => { const i = c.lines.indexOf(l); const vtd = l.value_override != null ? Number(l.value_override) : l.value * (Number(l.pct) || 0) / 100; return `<tr${l.rate == null ? ' style="opacity:.6"' : ''}><td>${esc(l.description)}${l.spec ? `<div class="small muted">${esc(l.spec)}</div>` : ''}</td><td class="n">${fmt(l.qty, 2)} ${esc(l.unit || '')}</td><td class="n">${l.rate != null ? fmt(l.rate, 2) : '<span class="flag">no rate</span>'}</td><td class="n">${fmt(l.value, 2)}</td>
        <td class="n small">${fmt(l.prev_pct || 0, 1)}</td><td class="n small" title="${esc(l.source || '')}">${fmt(l.pct_auto, 1)}</td>
        <td class="n"><input class="num" style="width:70px" data-pct="${i}" inputmode="decimal" value="${l.pct ?? ''}" ${dis}>${l.edited ? ' ✎' : ''}</td><td class="n"><input class="num" style="width:110px" data-val="${i}" inputmode="decimal" value="${vtd ? vtd.toFixed(2) : ''}" ${dis}></td></tr>`; }).join('')).join('')}
      <tr class="tot"><td colspan="3">Total</td><td class="n">${fmt(T.contract, 2)}</td><td></td><td></td><td class="n">${fmt(T.pct * 100, 1)}%</td><td class="n">${fmt(T.gross, 2)}</td></tr></tbody></table></div></section>
    <section class="card"><div class="hd"><h3>Jobcards in this period</h3><span class="small muted">${jcs.length} submitted</span></div>
      ${jcs.length ? `<div class="tbl"><table><tbody>${jcs.map(j => `<tr><td>${fmtDate(j.card_date)}</td><td class="small">${esc((j.tasks || []).filter(t => t.state).map(t => `${t.name} (${t.state === 'done' ? 'done' : (t.pct ?? 0) + '%'})`).join('; '))}${(j.extra_tasks || []).length ? ' + ' + esc(j.extra_tasks.map(x => x.text).join('; ')) : ''}</td><td>${j.status === 'approved' ? '<span class="pill ok">Approved</span>' : '<span class="pill info">Submitted</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">No submitted jobcards in this period.</div>'}</section>
    <section class="card"><div class="bd stack">
      <label class="f">Notes on the certificate<textarea name="notes" ${dis}>${esc(c.notes || '')}</textarea></label>
      ${c.status !== 'draft' ? `<div class="grid3"><label class="f">Certified by client (E excl. VAT)<input name="certified" inputmode="decimal" value="${c.certified ?? ''}"></label><label class="f">Paid (E)<input name="paid" inputmode="decimal" value="${c.paid ?? ''}"></label><label class="f">Paid on<input type="date" name="paid_date" value="${esc(c.paid_date || '')}"></label></div>` : ''}
      <div class="row"><span class="grow"></span>${cert && c.status === 'draft' ? '<button class="btn danger" id="del">Delete</button>' : ''}
        ${canEdit ? '<button class="btn" id="save">Save draft</button>' + (admin ? '<button class="btn primary" id="issue">Issue to client</button>' : '<span class="small muted">Matt or the QS issues the certificate.</span>') : ''}
        ${!canEdit && admin ? `${c.status === 'issued' && admin ? '<button class="btn" id="reopen">Back to draft</button>' : ''}<button class="btn primary" id="upd">Save certification / payment</button>` : ''}</div></div></section>`;
    wire();
  };
  const readTop = () => {
    const q = n => el.querySelector(`[name=${n}]`);
    if (canEdit) { c.number = q('number').value; c.period_from = q('period_from').value; c.period_to = q('period_to').value; c.claim_date = q('claim_date').value; c.retention_pct = num(q('retention_pct').value) ?? 10; c.retention_cap = num(q('retention_cap').value) ?? 5; c.notes = q('notes').value; }
    if (q('certified')) { c.certified = num(q('certified').value); c.paid = num(q('paid').value); c.paid_date = q('paid_date').value || null; }
  };
  const save = async (extra = {}) => {
    readTop(); Object.assign(c, extra);
    const T = ipcTotals(c, prevCerts);
    if (c.certified != null && c.status === 'issued') c.status = 'certified';
    if (c.paid && c.paid >= (c.certified ?? T.due) - 0.005) c.status = 'paid';
    const row = { project_id: project.id, number: c.number, claim_date: c.claim_date, period_from: c.period_from, period_to: c.period_to, lines: c.lines, retention_pct: c.retention_pct, retention_cap: c.retention_cap, vat_rate: c.vat_rate,
      gross_to_date: T.gross, retention_amt: T.retention, prev_certified: T.prev, net_to_date: T.net, claimed: T.due, vat: T.vat, status: c.status, certified: c.certified ?? null, paid: c.paid ?? null, paid_date: c.paid_date ?? null, notes: c.notes || null, jobcard_ids: jcIn().map(j => j.id) };
    cert = cert ? await store.update('claims', cert.id, row) : await store.insert('claims', row);
    return cert;
  };
  const wire = () => {
    const q = s => el.querySelector(s);
    el.querySelectorAll('[data-pct]').forEach(i => i.onchange = () => { readTop(); const l = c.lines[+i.dataset.pct]; l.pct = Math.min(100, Math.max(0, num(i.value) ?? 0)); delete l.value_override; l.edited = Math.abs(l.pct - l.pct_auto) > 0.05; draw(); });
    el.querySelectorAll('[data-val]').forEach(i => i.onchange = () => { readTop(); const l = c.lines[+i.dataset.val]; const v = num(i.value); if (v == null) delete l.value_override; else { l.value_override = v; l.pct = l.value ? Math.round(v / l.value * 1000) / 10 : 0; } l.edited = true; draw(); });
    el.querySelectorAll('[name=retention_pct],[name=retention_cap]').forEach(i => i.onchange = () => { readTop(); draw(); });
    q('#print').onclick = () => { readTop(); openIpcDoc(project, c, ipcTotals(c, prevCerts), jcIn()); };
    q('#refresh') && (q('#refresh').onclick = () => {
      readTop(); const now = Object.fromEntries(clientLines(C).map(l => [l.key, l]));
      const kept = c.lines.filter(l => now[l.key]).map(l => ({ ...now[l.key], prev_pct: l.prev_pct, pct: l.edited ? l.pct : Math.max(l.prev_pct || 0, now[l.key].pct_auto), value_override: l.edited ? l.value_override : undefined, edited: l.edited }));
      for (const k of Object.keys(now)) if (!kept.some(l => l.key === k)) kept.push({ ...now[k], prev_pct: 0, pct: now[k].pct_auto });
      c.lines = kept; draw(); toast('Updated from the latest jobcards (amended lines kept)');
    });
    q('#save') && (q('#save').onclick = async () => { await save(); toast('Certificate saved'); ctx.go(`#/p/${project.id}/certs/ipc/${cert.id}`); });
    q('#issue') && (q('#issue').onclick = async () => { if (!(await confirmDlg('Issue this certificate?', 'The lines are locked once issued. You can still record what the client certifies and pays.', 'Issue'))) return; await save({ status: 'issued', issued_at: new Date().toISOString() }); toast('Certificate issued'); ctx.go(`#/p/${project.id}/certs/ipc/${cert.id}`); });
    q('#upd') && (q('#upd').onclick = async () => { await save(); toast('Saved'); ctx.reload(); });
    q('#reopen') && (q('#reopen').onclick = async () => { await store.update('claims', cert.id, { status: 'draft' }); ctx.reload(); });
    q('#del') && (q('#del').onclick = async () => { if (await confirmDlg('Delete certificate?', c.number)) { await store.remove('claims', cert.id); ctx.go(`#/p/${project.id}/certs`); } });
  };
  draw();
}

export function openIpcDoc(project, c, T, jcs) {
  const groups = groupBy(c.lines, l => l.group);
  open(`${head('Interim Payment Certificate', `<div style="font-size:13px">${esc(project.name)}${project.client ? ' · ' + esc(project.client) : ''}</div>`)}
  <div class="meta"><div><b>Certificate no:</b> ${esc(c.number)}<br><b>Date:</b> ${fmtDate(c.claim_date)}<br><b>Period:</b> ${fmtDate(c.period_from)} – ${fmtDate(c.period_to)}</div><div><b>Client:</b> ${esc(project.client || '')}<br><b>Project ref:</b> ${esc(project.code || '')}<br><b>Status:</b> ${esc(IPC_STATUS[c.status] || '')}</div></div>
  <table style="max-width:520px;margin-left:auto"><tbody>
    <tr><td>Contract value incl. variations</td><td class="n">${money(T.contract)}</td></tr>
    <tr><td>Value of work done to date (${fmt(T.pct * 100, 1)}%)</td><td class="n">${money(T.gross)}</td></tr>
    <tr><td>Less retention (${fmt(c.retention_pct, 1)}%, capped at ${fmt(c.retention_cap, 1)}% of contract)</td><td class="n">(${money(T.retention)})</td></tr>
    <tr><td>Net value to date</td><td class="n">${money(T.net)}</td></tr>
    <tr><td>Less previously certified</td><td class="n">(${money(T.prev)})</td></tr>
    <tr class="tot"><td>Amount due this certificate excl. VAT</td><td class="n">${money(T.due)}</td></tr>
    <tr><td>VAT ${fmt(c.vat_rate * 100)}%</td><td class="n">${money(T.vat)}</td></tr>
    <tr class="tot"><td>Total due incl. VAT</td><td class="n">${money(T.total)}</td></tr></tbody></table>
  <h3 style="font-size:14px;margin:16px 0 0">Valuation</h3>
  <table><thead><tr><th>Item</th><th class="n">Qty</th><th>Unit</th><th class="n">Rate</th><th class="n">Amount</th><th class="n">% done</th><th class="n">Value to date</th></tr></thead><tbody>
  ${Object.entries(groups).map(([g, ls]) => `<tr class="sec"><td colspan="7">${esc(g)}</td></tr>` + ls.map(l => { const v = l.value_override != null ? Number(l.value_override) : l.value * (Number(l.pct) || 0) / 100; return `<tr><td>${esc(l.description)}${l.spec ? ` <span style="color:#666">(${esc(l.spec)})</span>` : ''}</td><td class="n">${fmt(l.qty, 2)}</td><td>${esc(l.unit || '')}</td><td class="n">${l.rate != null ? fmt(l.rate, 2) : '–'}</td><td class="n">${fmt(l.value, 2)}</td><td class="n">${fmt(l.pct, 1)}%</td><td class="n">${fmt(v, 2)}</td></tr>`; }).join('')).join('')}
  <tr class="tot"><td colspan="4">Total</td><td class="n">${fmt(T.contract, 2)}</td><td class="n">${fmt(T.pct * 100, 1)}%</td><td class="n">${fmt(T.gross, 2)}</td></tr></tbody></table>
  ${c.notes ? `<div class="box"><b>Notes</b><div style="white-space:pre-wrap">${esc(c.notes)}</div></div>` : ''}
  ${jcs?.length ? `<h3 style="font-size:14px;margin:16px 0 0">Supporting site records</h3><p style="font-size:12px">Progress is supported by ${jcs.length} daily jobcards signed by the Du Green site supervisor between ${fmtDate(jcs[0].card_date)} and ${fmtDate(jcs[jcs.length - 1].card_date)}, available on request.</p>` : ''}
  <div class="sig"><div>Prepared for Du Green Investments</div><div>Certified for the client (name, signature, date)</div></div>
  <p style="font-size:11.5px;color:#555;margin-top:14px">Amounts in Emalangeni. Banking details as per Du Green invoice.</p>`, c.number);
}

// ---------------------------------------------------- subcontractor certs
function subList(el, ctx, C) {
  const { project } = ctx;
  const subs = C.contracts.filter(c => c.type === 'subcontract' && c.status === 'signed');
  el.innerHTML = `${subs.length ? '' : '<div class="note">No signed subcontracts on this project yet. Supervisors sign them on site from the jobcard, or from People → a subcontractor → New contract.</div>'}
    ${subs.map(sc => { const p = C.staffBy[sc.person_id]; const cs = C.subCerts.filter(x => x.contract_id === sc.id).sort((a, b) => String(a.cert_date).localeCompare(String(b.cert_date))); const last = cs[cs.length - 1];
      return `<section class="card"><div class="hd"><div class="grow"><h3>${esc(p?.name || sc.data?.company || 'Subcontractor')}</h3><div class="small muted">${esc(sc.number)} · ${esc(SUB_BASIS[sc.data?.basis] || '')} · sum ${money(Number(sc.data?.contract_sum) || 0, 0)} · retention ${fmt(sc.data?.retention_pct ?? 10)}% cap ${fmt(sc.data?.retention_cap ?? 5)}%${sc.data?.pay_when_paid === false ? '' : ' · pay-when-paid'}</div></div>
        <a class="btn small primary" href="#/p/${project.id}/certs/subc/new?c=${sc.id}">+ New certificate</a></div>
        ${cs.length ? `<div class="tbl"><table><thead><tr><th>Cert</th><th>Period to</th><th class="n">Gross to date</th><th class="n">Due this cert</th><th>Payable</th><th>Status</th></tr></thead><tbody>${cs.map(x => `<tr class="click" data-sc="${x.id}"><td><b>${esc(x.number)}</b></td><td>${fmtDate(x.period_to)}</td><td class="n">${fmt(x.gross_to_date, 2)}</td><td class="n">${fmt(x.amount_due, 2)}</td><td class="small">${payableText(x, C)}</td><td>${subPill(x.status)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">No certificates yet.</div>'}</section>`; }).join('')}`;
  el.querySelectorAll('[data-sc]').forEach(r => r.onclick = () => ctx.go(`#/p/${project.id}/certs/subc/${r.dataset.sc}`));
}

// Pay-when-paid: payable N days after the client pays the certificate that covers this period.
function payableText(x, C) {
  const sc = C.contracts.find(c => c.id === x.contract_id); const d = sc?.data || {};
  if (x.status === 'paid') return 'Paid ' + fmtDate(x.paid_date);
  if (d.pay_when_paid === false) return `Within ${d.pay_days ?? 7} days of approval`;
  const ipc = C.claims.filter(c => String(c.period_to) >= String(x.period_to)).sort((a, b) => String(a.period_to).localeCompare(String(b.period_to)))[0];
  if (!ipc) return '<span class="flag">Waiting for a client certificate covering this period</span>';
  if (ipc.status !== 'paid') return `When client pays ${esc(ipc.number)} (${esc(IPC_STATUS[ipc.status || 'draft'])})`;
  return `<b>Due by ${fmtDate(addDays(ipc.paid_date || today(), Number(d.pay_days ?? 7)))}</b> · client paid ${esc(ipc.number)}`;
}

function subValuation(C, sc, periodTo, prev) {
  const d = sc.data || {};
  const areaIds = d.area_ids || [];
  const ps = areaIds.map(id => C.areaPct(id)).filter(v => v != null);
  const pAuto = Math.round((ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : C.overall) * 1000) / 10;
  const days = C.jobcards.filter(j => j.status !== 'draft' && j.card_date <= periodTo).reduce((t, j) => t + (j.subbies || []).filter(s => s.person_id === sc.person_id).reduce((u, s) => u + (Number(s.crew) || 1) * (Number(s.hours) || 8) / 8, 0), 0);
  const prevBy = Object.fromEntries((prev?.lines || []).map(l => [l.key, l]));
  if (d.basis === 'day_rate') return [{ key: 'days', description: `Person-days on site to ${fmtDate(periodTo)} (from jobcards)`, unit: 'person-day', qty_auto: r2(days), qty: r2(days), rate: Number(d.day_rate) || 0 }];
  if (d.basis === 'measured') return (d.lines || []).map((l, i) => { const k = 'm' + i, auto = r2((Number(l.qty) || 0) * pAuto / 100); return { key: k, description: l.description, unit: l.unit, contract_qty: Number(l.qty) || 0, qty_auto: auto, qty: Math.max(prevBy[k]?.qty ?? 0, auto), rate: Number(l.rate) || 0 }; });
  return [{ key: 'ls', description: d.scope || 'Subcontract works', unit: '%', contract_qty: 100, qty_auto: pAuto, qty: Math.max(prevBy.ls?.qty ?? 0, pAuto), rate: (Number(d.contract_sum) || 0) / 100 }];
}
export function subTotals(x, sc, prevCerts) {
  const d = sc?.data || {};
  const work = r2((x.lines || []).reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0));
  const extras = r2((x.extras || []).reduce((t, e) => t + (Number(e.amount) || 0), 0));
  const gross = r2(work + extras);
  const sum = Number(d.contract_sum) || gross;
  const retention = r2(Math.min(gross * Number(d.retention_pct ?? 10) / 100, sum * Number(d.retention_cap ?? 5) / 100));
  const prev = r2(prevCerts.reduce((t, p) => Math.max(t, Number(p.net_to_date) || 0), 0));
  const less = r2((x.deductions || []).reduce((t, e) => t + (Number(e.amount) || 0), 0));
  const net = r2(gross - retention), due = r2(net - prev - less);
  return { work, extras, gross, retention, prev, less, net, due };
}

async function subEditor(el, ctx, C, id) {
  const { store, project, me } = ctx;
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  let rec = id && id !== 'new' ? C.subCerts.find(x => x.id === id) : null;
  const sc = C.contracts.find(c => c.id === (rec?.contract_id || qs.get('c')));
  if (!sc) { el.innerHTML = '<div class="card empty">Subcontract not found.</div>'; return; }
  const person = C.staffBy[sc.person_id] || { name: sc.data?.company };
  const mine = C.subCerts.filter(x => x.contract_id === sc.id && x.id !== rec?.id && (!rec || String(x.cert_date) <= String(rec.cert_date))).sort((a, b) => String(a.cert_date).localeCompare(String(b.cert_date)));
  const prev = mine[mine.length - 1];
  const x = rec ? JSON.parse(JSON.stringify(rec)) : { number: `${sc.number.replace('DG-SC-', 'SC')}-${String(mine.length + 1).padStart(2, '0')}`, cert_date: today(), period_from: prev?.period_to ? addDays(prev.period_to, 1) : (sc.start_date || today()), period_to: today(), status: 'draft', extras: [], deductions: [] };
  if (!rec) x.lines = subValuation(C, sc, x.period_to, prev);
  const canEdit = x.status === 'draft', approver = canSetRates(me);
  const draw = () => {
    const T = subTotals(x, sc, mine);
    const dis = canEdit ? '' : 'disabled';
    el.innerHTML = `<section class="card"><div class="hd"><div class="grow"><div class="small muted"><a href="#/p/${project.id}/certs/sub">Subcontractor certificates</a> /</div><h3>${esc(x.number)} · ${esc(person.name)}</h3><div class="small muted">${esc(sc.number)} · ${esc(SUB_BASIS[sc.data?.basis] || '')}</div></div>${subPill(x.status)}
        ${canEdit ? '<button class="btn" id="refresh">Refresh from jobcards</button>' : ''}<button class="btn" id="print">Print / PDF</button></div>
      <div class="bd grid3"><label class="f">Certificate no.<input name="number" value="${esc(x.number)}" ${dis}></label><label class="f">Period from<input type="date" name="period_from" value="${esc(x.period_from)}" ${dis}></label><label class="f">Period to<input type="date" name="period_to" value="${esc(x.period_to)}" ${dis}></label></div></section>
    <div class="kpis"><div class="kpi"><div class="k">Gross to date</div><div class="v">${money(T.gross, 0)}</div><div class="small muted">of ${money(Number(sc.data?.contract_sum) || 0, 0)}</div></div>
      <div class="kpi"><div class="k">Retention held</div><div class="v">${money(T.retention, 0)}</div></div>
      <div class="kpi"><div class="k">Previously certified</div><div class="v">${money(T.prev, 0)}</div></div>
      <div class="kpi"><div class="k">Due this certificate</div><div class="v">${money(T.due, 2)}</div><div class="small muted">${payableText({ ...x, contract_id: sc.id }, C)}</div></div></div>
    <section class="card"><div class="hd"><h3>Work done</h3><span class="small muted">Starts from the jobcards and the programme. Change the quantity to amend.</span></div>
      <div class="tbl"><table><thead><tr><th>Item</th><th class="n">Contract qty</th><th class="n">From jobcards</th><th class="n">Qty to date</th><th>Unit</th><th class="n">Rate</th><th class="n">Value</th></tr></thead><tbody>
      ${x.lines.map((l, i) => `<tr><td>${esc(l.description)}</td><td class="n">${l.contract_qty != null ? fmt(l.contract_qty, 2) : '–'}</td><td class="n small">${fmt(l.qty_auto, 2)}</td><td class="n"><input class="num" style="width:90px" data-q="${i}" inputmode="decimal" value="${l.qty ?? ''}" ${dis}>${Math.abs((l.qty || 0) - (l.qty_auto || 0)) > 0.005 ? ' ✎' : ''}</td><td>${esc(l.unit || '')}</td><td class="n">${fmt(l.rate, 2)}</td><td class="n">${fmt((Number(l.qty) || 0) * (Number(l.rate) || 0), 2)}</td></tr>`).join('')}
      ${(x.extras || []).map((e, i) => `<tr><td><input data-e="${i}" data-k="description" value="${esc(e.description)}" placeholder="Variation (e.g. SI-001 extra paving)" ${dis}></td><td colspan="5"></td><td class="n"><input class="num" style="width:110px" data-e="${i}" data-k="amount" inputmode="decimal" value="${e.amount ?? ''}" ${dis}></td></tr>`).join('')}
      <tr class="tot"><td colspan="6">Gross value to date</td><td class="n">${fmt(T.gross, 2)}</td></tr></tbody></table></div>
      ${canEdit ? '<div class="row" style="padding:10px 14px"><button class="btn small" id="adde">+ Variation</button><button class="btn small" id="addd">+ Deduction</button></div>' : ''}
      ${(x.deductions || []).length ? `<div class="bd stack" style="gap:6px"><b class="small">Deductions this certificate</b>${x.deductions.map((e, i) => `<div class="grid3"><input class="span2" data-dd="${i}" data-k="description" value="${esc(e.description)}" placeholder="e.g. Damaged materials, advance repaid" ${dis}><input class="num" data-dd="${i}" data-k="amount" inputmode="decimal" value="${e.amount ?? ''}" ${dis}></div>`).join('')}</div>` : ''}</section>
    <section class="card"><div class="bd stack"><label class="f">Notes<textarea name="notes" ${dis}>${esc(x.notes || '')}</textarea></label>
      ${x.status === 'approved' ? `<div class="grid2"><label class="f">Paid on<input type="date" name="paid_date" value="${esc(x.paid_date || '')}"></label><label class="f">Payment reference<input name="paid_ref" value="${esc(x.paid_ref || '')}"></label></div>` : ''}
      <div class="row"><span class="grow"></span>${rec && canEdit ? '<button class="btn danger" id="del">Delete</button>' : ''}${canEdit ? `<button class="btn" id="save">Save draft</button>${approver ? '<button class="btn primary" id="approve">Approve certificate</button>' : ''}` : ''}
        ${x.status === 'approved' && approver ? '<button class="btn" id="unapprove">Back to draft</button><button class="btn primary" id="paid">Record payment</button>' : ''}</div></div></section>`;
    wire();
  };
  const readAll = () => {
    const q = n => el.querySelector(`[name=${n}]`);
    if (canEdit) { x.number = q('number').value; x.period_from = q('period_from').value; x.period_to = q('period_to').value; x.notes = q('notes').value;
      el.querySelectorAll('[data-q]').forEach(i => { x.lines[+i.dataset.q].qty = num(i.value) ?? 0; });
      el.querySelectorAll('[data-e]').forEach(i => { x.extras[+i.dataset.e][i.dataset.k] = i.dataset.k === 'amount' ? num(i.value) : i.value; });
      el.querySelectorAll('[data-dd]').forEach(i => { x.deductions[+i.dataset.dd][i.dataset.k] = i.dataset.k === 'amount' ? num(i.value) : i.value; }); }
    if (q('paid_date')) { x.paid_date = q('paid_date').value || null; x.paid_ref = q('paid_ref').value || null; }
  };
  const save = async (extra = {}) => {
    readAll(); Object.assign(x, extra);
    const T = subTotals(x, sc, mine);
    const row = { project_id: project.id, contract_id: sc.id, person_id: sc.person_id, number: x.number, cert_date: x.cert_date, period_from: x.period_from, period_to: x.period_to, lines: x.lines, extras: x.extras, deductions: x.deductions,
      gross_to_date: T.gross, retention_amt: T.retention, prev_certified: T.prev, net_to_date: T.net, amount_due: T.due, status: x.status, notes: x.notes || null, paid_date: x.paid_date || null, paid_ref: x.paid_ref || null };
    rec = rec ? await store.update('sub_certs', rec.id, row) : await store.insert('sub_certs', row);
    return rec;
  };
  const wire = () => {
    const q = s => el.querySelector(s);
    el.querySelectorAll('[data-q],[data-e],[data-dd]').forEach(i => i.onchange = () => { readAll(); draw(); });
    q('#print').onclick = () => { readAll(); openSubCertDoc(project, x, sc, person, subTotals(x, sc, mine)); };
    q('#refresh') && (q('#refresh').onclick = () => { readAll(); const fresh = subValuation(C, sc, x.period_to, prev); x.lines = fresh; draw(); toast('Quantities refreshed from the jobcards'); });
    q('#adde') && (q('#adde').onclick = () => { readAll(); x.extras.push({ description: '', amount: null }); draw(); });
    q('#addd') && (q('#addd').onclick = () => { readAll(); x.deductions.push({ description: '', amount: null }); draw(); });
    q('#save') && (q('#save').onclick = async () => { await save(); toast('Saved'); ctx.go(`#/p/${project.id}/certs/subc/${rec.id}`); });
    q('#approve') && (q('#approve').onclick = async () => { await save({ status: 'approved', approved_at: new Date().toISOString(), approved_by_name: me?.full_name || null }); toast('Certificate approved'); ctx.go(`#/p/${project.id}/certs/subc/${rec.id}`); });
    q('#unapprove') && (q('#unapprove').onclick = async () => { await store.update('sub_certs', rec.id, { status: 'draft' }); ctx.reload(); });
    q('#paid') && (q('#paid').onclick = async () => { readAll(); if (!x.paid_date) return toast('Enter the date it was paid'); await save({ status: 'paid' }); toast('Payment recorded'); ctx.reload(); });
    q('#del') && (q('#del').onclick = async () => { if (await confirmDlg('Delete certificate?', x.number)) { await store.remove('sub_certs', rec.id); ctx.go(`#/p/${project.id}/certs/sub`); } });
  };
  draw();
}

export function openSubCertDoc(project, x, sc, person, T) {
  const d = sc.data || {};
  open(`${head('Subcontractor Payment Certificate', `<div style="font-size:13px">${esc(project.name)}</div>`)}
  <div class="meta"><div><b>Certificate no:</b> ${esc(x.number)}<br><b>Date:</b> ${fmtDate(x.cert_date)}<br><b>Period:</b> ${fmtDate(x.period_from)} – ${fmtDate(x.period_to)}</div>
    <div><b>Subcontractor:</b> ${esc(person.name)}<br><b>Agreement:</b> ${esc(sc.number)} (${esc(SUB_BASIS[d.basis] || '')})<br><b>Subcontract sum:</b> ${money(Number(d.contract_sum) || 0)}</div></div>
  <table><thead><tr><th>Item</th><th class="n">Qty to date</th><th>Unit</th><th class="n">Rate</th><th class="n">Value</th></tr></thead><tbody>
    ${x.lines.map(l => `<tr><td>${esc(l.description)}</td><td class="n">${fmt(l.qty, 2)}</td><td>${esc(l.unit || '')}</td><td class="n">${fmt(l.rate, 2)}</td><td class="n">${fmt((Number(l.qty) || 0) * (Number(l.rate) || 0), 2)}</td></tr>`).join('')}
    ${(x.extras || []).filter(e => e.amount).map(e => `<tr><td>${esc(e.description || 'Variation')}</td><td></td><td></td><td></td><td class="n">${fmt(e.amount, 2)}</td></tr>`).join('')}
    <tr class="tot"><td colspan="4">Gross value to date</td><td class="n">${fmt(T.gross, 2)}</td></tr>
    <tr><td colspan="4">Less retention (${fmt(d.retention_pct ?? 10, 1)}%, capped at ${fmt(d.retention_cap ?? 5, 1)}% of the subcontract sum)</td><td class="n">(${fmt(T.retention, 2)})</td></tr>
    <tr><td colspan="4">Less previously certified</td><td class="n">(${fmt(T.prev, 2)})</td></tr>
    ${(x.deductions || []).filter(e => e.amount).map(e => `<tr><td colspan="4">Less: ${esc(e.description || 'Deduction')}</td><td class="n">(${fmt(e.amount, 2)})</td></tr>`).join('')}
    <tr class="tot"><td colspan="4">Amount due this certificate (excl. VAT)</td><td class="n">${fmt(T.due, 2)}</td></tr></tbody></table>
  <div class="box"><b>Payment terms</b><div>${d.pay_when_paid === false ? `Payable within ${d.pay_days ?? 7} days of approval.` : `Pay-when-paid: payable within ${d.pay_days ?? 7} days after Du Green receives payment from the client for the work in this certificate.`} Paid only to the bank account on the subcontract agreement.</div></div>
  ${x.notes ? `<div class="box"><b>Notes</b><div style="white-space:pre-wrap">${esc(x.notes)}</div></div>` : ''}
  <div class="sig"><div>Approved for Du Green${x.approved_by_name ? ': ' + esc(x.approved_by_name) : ''}</div><div>Accepted by the Subcontractor</div></div>`, x.number);
}
