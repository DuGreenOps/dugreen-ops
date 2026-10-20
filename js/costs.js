// Cost management & reports: budget (from Costing) vs committed (POs) vs actual (deliveries, labour, expenses),
// variations from site instructions, claims/certificates, forecast margin.
import { esc, fmt, money, dialog, formData, toast, confirmDlg, num, today, fmtDate, CATEGORIES, groupBy, downloadFile, csvCell, uid } from './util.js';
import { loadProcurement } from './procure.js';
import { getSetting } from './store.js';
import { progress } from './pow.js';
import { openReportDoc } from './docs.js';
import { dayCost } from './staff.js';

const COMMITTED = ['approved', 'issued', 'part', 'received'];

export async function projectFinancials(store, project) {
  const [D, costRows, jobcards, expenses, claims, sis, tasks, casualRate, staff, contracts, subCerts] = await Promise.all([
    loadProcurement(store, project), store.list('costing', { project_id: project.id }, null), store.list('jobcards', { project_id: project.id }, 'card_date'),
    store.list('expenses', { project_id: project.id }, 'exp_date'), store.list('claims', { project_id: project.id }, 'claim_date'),
    store.list('site_instructions', { project_id: project.id }), store.list('tasks', { project_id: project.id }, null), getSetting(store, 'casual_day_rate', null),
    store.list('staff', {}, null), store.list('contracts', { project_id: project.id }, null), store.list('sub_certs', { project_id: project.id }, 'cert_date')]);
  const staffBy = Object.fromEntries(staff.map(s => [s.id, s]));
  const cost = Object.fromEntries(costRows.map(c => [c.item_key, c]));
  const catOf = {}; D.items.forEach(i => catOf[i.item_key] = i.category || 'Other');
  const cats = {};
  const C = k => (cats[k] = cats[k] || { cat: k, budget: 0, sell: 0, committed: 0, received: 0, labour: 0, expenses: 0 });
  let unpricedBudget = 0, missingMarkup = 0;
  for (const i of D.items) {
    const c = cost[i.item_key] || {}, s = D.selBy[i.item_key];
    const cr = c.cost_override != null ? Number(c.cost_override) : s ? Number(s.unit_price) : i.unit_cost != null ? Number(i.unit_cost) : null;
    const sell = c.sell_override != null ? Number(c.sell_override) : cr != null && c.markup_pct != null ? cr * (1 + Number(c.markup_pct) / 100) : null;
    if (cr == null) unpricedBudget++; else C(i.category || 'Other').budget += cr * i.qty;
    if (sell == null) missingMarkup++; else C(i.category || 'Other').sell += sell * i.qty;
  }
  for (const po of D.pos.filter(p => COMMITTED.includes(p.status))) {
    for (const l of D.poLines.filter(l => l.po_id === po.id)) {
      const v = Number(l.qty) * Number(l.unit_price), k = catOf[l.item_key] || 'Other';
      C(k).committed += v;
      if (po.status === 'received') C(k).received += v;
      else if (po.status === 'part') C(k).received += Math.min(Number(l.qty_received) || 0, Number(l.qty)) * Number(l.unit_price);
    }
  }
  // Labour from submitted / approved jobcards
  let personDays = 0, labourUnpriced = 0;
  for (const j of jobcards.filter(j => j.status !== 'draft')) for (const s of j.staff || []) {
    const days = (Number(s.hours) || 8) / 8 * (Number(s.count) || 1);
    personDays += days;
    const reg = s.staff_id ? dayCost(staffBy[s.staff_id]) : null;
    const rate = reg != null ? reg : s.day_rate != null ? Number(s.day_rate) : s.casual ? (casualRate != null ? Number(casualRate) : null) : null;
    if (rate == null) labourUnpriced += days; else C('Labour').labour += days * rate;
  }
  for (const e of expenses) C(e.category || 'Other').expenses += Number(e.amount) || 0;
  // Subcontractors: committed = signed subcontract sums; actual = latest approved certificate (gross value to date).
  const subs = contracts.filter(c => c.type === 'subcontract' && c.status === 'signed');
  for (const c of subs) { const S = C('Subcontractors'); S.committed += Number(c.data?.contract_sum) || 0; S.budget += 0; }
  const lastCert = {};
  for (const sc of subCerts.filter(x => ['approved', 'paid'].includes(x.status))) if (!lastCert[sc.contract_id] || String(sc.cert_date) >= String(lastCert[sc.contract_id].cert_date)) lastCert[sc.contract_id] = sc;
  for (const sc of Object.values(lastCert)) C('Subcontractors').received += Number(sc.gross_to_date) || 0;
  const rows = Object.values(cats).map(r => ({ ...r, actual: r.received + r.labour + r.expenses, forecast: Math.max(r.budget, r.committed + r.labour + r.expenses) }))
    .sort((a, b) => (CATEGORIES.indexOf(a.cat) + 1 || 99) - (CATEGORIES.indexOf(b.cat) + 1 || 99));
  const T = k => rows.reduce((t, r) => t + r[k], 0);
  const variations = sis.filter(s => s.cost_impact && s.status === 'approved').reduce((t, s) => t + (Number(s.est_value) || 0), 0);
  const pendingVariations = sis.filter(s => s.cost_impact && ['open', 'signed', 'priced'].includes(s.status)).reduce((t, s) => t + (Number(s.est_value) || 0), 0);
  const contract = T('sell');
  const fin = {
    rows, contract, variations, pendingVariations, revenue: contract + variations,
    budget: T('budget'), committed: T('committed'), received: T('received'), labour: T('labour'), expensesTotal: T('expenses'), actual: T('actual'), forecast: T('forecast'),
    claimed: claims.reduce((t, c) => t + (Number(c.claimed) || 0), 0), certified: claims.reduce((t, c) => t + (Number(c.certified) || 0), 0), paid: claims.reduce((t, c) => t + (Number(c.paid) || 0), 0),
    personDays, labourUnpriced, unpricedBudget, missingMarkup, progress: progress(tasks),
    pendingPOs: D.pos.filter(p => p.status === 'pending'), D, jobcards, expenses, claims, sis, tasks, subCerts, contracts, staffBy,
    subPaid: subCerts.filter(x => x.status === 'paid').reduce((t, x) => t + (Number(x.amount_due) || 0), 0),
    subDue: subCerts.filter(x => x.status === 'approved').reduce((t, x) => t + (Number(x.amount_due) || 0), 0),
  };
  fin.margin = fin.revenue - fin.forecast;
  fin.marginPct = fin.revenue ? fin.margin / fin.revenue : null;
  fin.spentPct = fin.budget ? fin.actual / fin.budget : null;
  return fin;
}

// Grouped horizontal bars: budget / committed / actual per category (palette validated for both themes).
function chart(rows) {
  const data = rows.filter(r => r.budget || r.committed || r.actual);
  if (!data.length) return '<div class="empty small">No costs yet.</div>';
  const max = Math.max(...data.flatMap(r => [r.budget, r.committed, r.actual]), 1);
  const W = 1000, L = 160, R = 130, rowH = 46, bh = 10, gap = 2, H = data.length * rowH + 30;
  const sx = v => (W - L - R) * v / max;
  const series = [['budget', 'Budget', 'var(--s1)'], ['committed', 'Committed (POs)', 'var(--s2)'], ['actual', 'Actual to date', 'var(--s3)']];
  const ticks = [0, .25, .5, .75, 1].map(f => max * f);
  return `<div class="viz">
    <div class="row small" style="gap:14px;margin-bottom:6px">${series.map(([, l, c]) => `<span class="row" style="gap:6px"><i class="swatch" style="background:${c}"></i>${l}</span>`).join('')}</div>
    <div class="tbl"><svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:560px;max-width:${W}px;font:13px var(--body)" role="img" aria-label="Budget, committed and actual cost by category">
      ${ticks.map(t => `<line x1="${L + sx(t)}" x2="${L + sx(t)}" y1="0" y2="${H - 24}" stroke="var(--line)" stroke-width="1"/><text x="${L + sx(t)}" y="${H - 8}" text-anchor="middle" fill="var(--muted)">${t >= 1000 ? fmt(t / 1000) + 'k' : fmt(t)}</text>`).join('')}
      ${data.map((r, i) => { const y = i * rowH + 6; return `<text x="${L - 8}" y="${y + 19}" text-anchor="end" fill="var(--ink)">${esc(r.cat)}</text>` +
        series.map(([k, l, c], j) => { const w = Math.max(r[k] ? 2 : 0, sx(r[k])); const yy = y + j * (bh + gap); return `<g><title>${esc(r.cat)} · ${l}: ${money(r[k])}</title><rect x="${L}" y="${yy}" width="${w}" height="${bh}" rx="3" fill="${c}"/><rect x="${L}" y="${yy - 1}" width="${W - L - R}" height="${bh + 2}" fill="transparent"/></g>`; }).join('') +
        `<text x="${L + sx(Math.max(r.budget, r.committed, r.actual)) + 6}" y="${y + 19}" fill="var(--muted)">actual ${money(r.actual, 0)}</text>`; }).join('')}
    </svg></div></div>`;
}

export async function render(root, ctx) {
  const { store, project } = ctx;
  const F = await projectFinancials(store, project);
  const pct = v => v == null ? '–' : fmt(v * 100, 1) + '%';
  root.innerHTML = `<div class="page">
    <div class="row"><div class="grow"><div class="eyebrow">Project finance</div><h2 style="font-size:24px">Costs & reports</h2>
      <p class="small muted" style="margin:2px 0 0">Budget comes from Costing & BOQ, committed from approved POs, and actual from deliveries, jobcard labour and expenses.</p></div>
      <div class="row"><button class="btn" id="csv">Download CSV</button><button class="btn primary" id="print">Print report</button></div></div>
    <div class="kpis">
      <div class="kpi"><div class="k">Contract value</div><div class="v">${money(F.revenue, 0)}</div><div class="small muted">BOQ ${money(F.contract, 0)}${F.variations ? ` + variations ${money(F.variations, 0)}` : ''}</div></div>
      <div class="kpi"><div class="k">Budget cost</div><div class="v">${money(F.budget, 0)}</div><div class="small muted">Committed ${money(F.committed, 0)}</div></div>
      <div class="kpi"><div class="k">Actual cost to date</div><div class="v">${money(F.actual, 0)}</div><div class="small muted">${pct(F.spentPct)} of budget · work ${fmt(F.progress * 100)}% done</div></div>
      <div class="kpi"><div class="k">Forecast margin</div><div class="v" style="color:${F.margin < 0 ? 'var(--bad)' : 'inherit'}">${money(F.margin, 0)}</div><div class="small muted">${pct(F.marginPct)} of contract</div></div>
    </div>
    ${[F.unpricedBudget ? `${F.unpricedBudget} spec items have no cost yet` : '', F.missingMarkup ? `${F.missingMarkup} items have no mark-up, so the contract value is understated` : '', F.labourUnpriced ? `${fmt(F.labourUnpriced, 1)} person-days have no day rate (set rates in the Staff register, and the casual rate in Settings)` : '', F.pendingVariations ? `${money(F.pendingVariations, 0)} of variations from site instructions are not yet approved` : '', F.spentPct != null && F.spentPct > F.progress + 0.1 ? `Spending (${pct(F.spentPct)} of budget) is running ahead of progress (${fmt(F.progress * 100)}% done)` : ''].filter(Boolean).map(t => `<div class="note warn">${t}.</div>`).join('')}
    <section class="card"><div class="hd"><h3>Cost by category</h3></div><div class="bd">${chart(F.rows)}</div>
      <div class="tbl"><table><thead><tr><th>Category</th><th class="n">Budget</th><th class="n">Committed</th><th class="n">Delivered</th><th class="n">Labour</th><th class="n">Expenses</th><th class="n">Actual</th><th class="n">Forecast</th><th class="n">Variance</th></tr></thead><tbody>
      ${F.rows.map(r => `<tr><td>${esc(r.cat)}</td><td class="n">${fmt(r.budget, 2)}</td><td class="n">${fmt(r.committed, 2)}</td><td class="n">${fmt(r.received, 2)}</td><td class="n">${fmt(r.labour, 2)}</td><td class="n">${fmt(r.expenses, 2)}</td><td class="n"><b>${fmt(r.actual, 2)}</b></td><td class="n">${fmt(r.forecast, 2)}</td><td class="n" style="color:${r.forecast > r.budget ? 'var(--bad)' : 'inherit'}">${fmt(r.budget - r.forecast, 2)}</td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td class="n">${fmt(F.budget, 2)}</td><td class="n">${fmt(F.committed, 2)}</td><td class="n">${fmt(F.received, 2)}</td><td class="n">${fmt(F.labour, 2)}</td><td class="n">${fmt(F.expensesTotal, 2)}</td><td class="n">${fmt(F.actual, 2)}</td><td class="n">${fmt(F.forecast, 2)}</td><td class="n">${fmt(F.budget - F.forecast, 2)}</td></tr>
      </tbody></table></div></section>

    <div class="grid2" style="align-items:start">
      <section class="card"><div class="hd"><h3>Certificates</h3><span class="grow"></span><a class="btn small primary" href="#/p/${project.id}/certs">Open certificates</a></div>
        <div class="bd small stack" style="gap:4px"><div>Client: certified <b>${money(F.certified, 0)}</b> · paid <b>${money(F.paid, 0)}</b> · outstanding <b style="color:${F.certified - F.paid > 0 ? 'var(--warn)' : 'inherit'}">${money(F.certified - F.paid, 0)}</b></div>
          <div>Subcontractors: approved, not yet paid <b>${money(F.subDue, 0)}</b> · paid <b>${money(F.subPaid, 0)}</b></div>
          <div class="muted">Certificates are valued from the jobcards and the programme. Matt or the QS can amend them before issuing.</div></div></section>
      <section class="card"><div class="hd"><h3>Other expenses</h3><span class="small muted">fuel, hire, petty cash, transport</span><span class="grow"></span><button class="btn small primary" id="adde">+ Expense</button></div>
        ${F.expenses.length ? `<div class="tbl"><table><thead><tr><th>Date</th><th>Item</th><th>Category</th><th class="n">Amount</th></tr></thead><tbody>${[...F.expenses].reverse().map(e => `<tr class="click" data-e="${e.id}"><td>${fmtDate(e.exp_date)}</td><td>${esc(e.description || '')}<div class="small muted">${esc(e.supplier || '')}</div></td><td class="small">${esc(e.category || '')}</td><td class="n">${fmt(e.amount, 2)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">No expenses recorded.</div>'}</section>
    </div>
    <section class="card"><div class="hd"><h3>Labour from jobcards</h3></div><div class="bd small">${fmt(F.personDays, 1)} person-days on ${F.jobcards.filter(j => j.status !== 'draft').length} submitted jobcards · labour cost ${money(F.labour, 0)}</div></section>
  </div>`;
  const $ = s => root.querySelector(s);
  $('#adde').onclick = () => editExpense(ctx, null);
  root.querySelectorAll('[data-e]').forEach(r => r.onclick = () => editExpense(ctx, F.expenses.find(e => e.id === r.dataset.e)));
  $('#print').onclick = () => openReportDoc(project, F, chart(F.rows));
  $('#csv').onclick = () => {
    const head = ['Category', 'Budget', 'Committed', 'Delivered', 'Labour', 'Expenses', 'Actual', 'Forecast', 'Variance'];
    const lines = F.rows.map(r => [r.cat, r.budget, r.committed, r.received, r.labour, r.expenses, r.actual, r.forecast, r.budget - r.forecast].map(v => typeof v === 'number' ? v.toFixed(2) : v));
    lines.push([], ['Contract value', F.contract.toFixed(2)], ['Approved variations', F.variations.toFixed(2)], ['Forecast margin', F.margin.toFixed(2)], ['Claimed', F.claimed.toFixed(2)], ['Certified', F.certified.toFixed(2)], ['Paid', F.paid.toFixed(2)]);
    downloadFile(`${(project.code || project.name).replace(/[^A-Za-z0-9]+/g, '_')}_cost_report.csv`, '﻿' + [head, ...lines].map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv');
  };
}

async function editClaim(ctx, F, c) {
  const { store, project } = ctx;
  const v = await dialog({
    title: c ? c.number : 'New claim',
    body: `<div class="grid2"><label class="f">Claim / certificate no.<input name="number" value="${esc(c?.number || `IPC-${String(F.claims.length + 1).padStart(2, '0')}`)}"></label><label class="f">Date<input name="claim_date" type="date" value="${esc(c?.claim_date || today())}"></label></div>
      <div class="grid3"><label class="f">Claimed (E)<input name="claimed" inputmode="decimal" value="${c?.claimed ?? ''}"></label><label class="f">Certified (E)<input name="certified" inputmode="decimal" value="${c?.certified ?? ''}"></label><label class="f">Paid (E)<input name="paid" inputmode="decimal" value="${c?.paid ?? ''}"></label></div>
      <div class="grid2"><label class="f">Period to<input name="period_to" type="date" value="${esc(c?.period_to || '')}"></label><label class="f">Paid on<input name="paid_date" type="date" value="${esc(c?.paid_date || '')}"></label></div>
      <label class="f">Notes<input name="notes" value="${esc(c?.notes || '')}"></label><p class="small muted">Amounts excluding VAT.</p>`,
    buttons: [...(c ? [{ label: 'Delete', danger: true, value: 'delete' }] : []), { label: 'Cancel', value: null }, { label: 'Save', primary: true, value: w => formData(w) }],
  });
  if (!v) return;
  if (v === 'delete') { if (await confirmDlg('Delete claim?', c.number)) { await store.remove('claims', c.id); ctx.reload(); } return; }
  const row = { project_id: project.id, number: v.number, claim_date: v.claim_date || today(), period_to: v.period_to || null, claimed: num(v.claimed), certified: num(v.certified), paid: num(v.paid), paid_date: v.paid_date || null, notes: v.notes || null };
  c ? await store.update('claims', c.id, row) : await store.insert('claims', row);
  toast('Saved'); ctx.reload();
}

async function editExpense(ctx, e) {
  const { store, project } = ctx;
  let receipt = e?.receipt_path || null;
  const v = await dialog({
    title: e ? 'Expense' : 'New expense',
    body: `<div class="grid2"><label class="f">Date<input name="exp_date" type="date" value="${esc(e?.exp_date || today())}"></label><label class="f">Category<select name="category">${CATEGORIES.map(c => `<option ${(e?.category || 'Transport') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div>
      <label class="f">What for<input name="description" value="${esc(e?.description || '')}" placeholder="e.g. Diesel for TLB, hire of compactor"></label>
      <div class="grid2"><label class="f">Paid to<input name="supplier" value="${esc(e?.supplier || '')}"></label><label class="f">Amount excl. VAT (E)<input name="amount" inputmode="decimal" value="${e?.amount ?? ''}" required></label></div>
      <div class="row"><label class="btn small">${receipt ? 'Replace receipt' : 'Attach receipt photo'}<input type="file" accept="image/*,application/pdf" capture="environment" id="rc" hidden></label><span class="small muted" id="rcm">${receipt ? 'Receipt attached' : ''}</span></div>`,
    onOpen: w => { w.querySelector('#rc').onchange = async ev => { const f = ev.target.files[0]; if (!f) return; try { const path = `${project.id}/receipt-${uid()}.${(f.name.split('.').pop() || 'jpg').toLowerCase()}`; await store.upload('photos', path, f); receipt = path; w.querySelector('#rcm').textContent = 'Receipt attached'; } catch (err) { toast(err.message); } }; },
    buttons: [...(e ? [{ label: 'Delete', danger: true, value: 'delete' }] : []), { label: 'Cancel', value: null }, { label: 'Save', primary: true, value: w => formData(w), validate: w => num(w.querySelector('[name=amount]').value) != null }],
  });
  if (!v) return;
  if (v === 'delete') { if (await confirmDlg('Delete expense?', e.description || '')) { await store.remove('expenses', e.id); ctx.reload(); } return; }
  const row = { project_id: project.id, exp_date: v.exp_date || today(), category: v.category, description: v.description || null, supplier: v.supplier || null, amount: num(v.amount), receipt_path: receipt };
  e ? await store.update('expenses', e.id, row) : await store.insert('expenses', row);
  toast('Saved'); ctx.reload();
}
