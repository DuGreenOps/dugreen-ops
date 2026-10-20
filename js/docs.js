// Printable documents: RFQ, purchase order and client BOQ (open in a new tab → Print / Save as PDF).
import { CONFIG } from './config.js';
import { esc, fmt, money, fmtDate } from './util.js';

const CSS = `body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#111;margin:0;padding:28px}
.hd{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #2F6A17;padding-bottom:12px;margin-bottom:16px}
.hd img{height:70px}.co{font-size:12px;color:#333;text-align:right}.co b{font-size:15px;color:#111}
h1{font-size:22px;margin:0 0 4px;color:#2F6A17}.meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;margin-bottom:14px;font-size:12.5px}
table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#E8EFE2;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:6px 8px;border-bottom:1px solid #9AB58A}
td{padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top}td.n,th.n{text-align:right;white-space:nowrap}tr.tot td{font-weight:bold;border-top:2px solid #333}tr.sec td{background:#f3f3f3;font-weight:bold}
.box{border:1px solid #ccc;padding:10px 12px;margin-top:14px;font-size:12.5px}.sig{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:76px;font-size:12px}.sig div{border-top:1px solid #333;padding-top:4px;position:relative}.sig div img{position:absolute;bottom:100%;left:0;margin-bottom:2px}
.bar{position:sticky;top:0;background:#fff;padding:8px 0 12px;display:flex;gap:8px}.bar button{font:600 14px Arial;padding:8px 14px;border-radius:6px;border:1px solid #2F6A17;background:#2F6A17;color:#fff;cursor:pointer}
@media print{.bar{display:none}body{padding:0}}`;

function head(title, right) {
  const c = CONFIG.COMPANY;
  return `<div class="bar"><button onclick="print()">Print / Save as PDF</button></div>
  <div class="hd"><div><img src="${new URL('icons/logo.png', location.href)}" alt="Du Green Organic"><h1>${esc(title)}</h1>${right || ''}</div>
  <div class="co"><b>${esc(c.name)}</b><br>Trading as ${esc(c.trading)}<br>${esc(c.address)}<br>VAT No. ${esc(c.vat_no)}<br>${esc(c.email)}</div></div>`;
}
function open(html, title) {
  const w = window.open('', '_blank');
  if (!w) { alert('Allow pop-ups to open the document.'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${html}</body></html>`);
  w.document.close();
}

export function rfqText(rfq, lines, project, s) {
  return `Dear ${s?.contact || s?.name || 'Supplier'},

Du Green Investments requests your quotation for the items below.
Project: ${project.name}${project.site_address ? ' (' + project.site_address + ')' : ''}
RFQ: ${rfq.number}${rfq.due_date ? '\nPlease reply by: ' + fmtDate(rfq.due_date) : ''}

${lines.map((l, i) => `${i + 1}. ${l.description}${l.spec ? ' – ' + l.spec : ''}: ${fmt(l.qty, 2)} ${l.unit}`).join('\n')}

${rfq.notes || 'Please quote unit prices excluding VAT, with availability and lead time.'}

Kind regards,
Du Green Procurement
${CONFIG.COMPANY.email}`;
}

export function openRfqDoc(rfq, lines, project, s) {
  open(`${head('Request for Quotation')}
  <div class="meta"><div><b>To:</b> ${esc(s?.name || '')}${s?.contact ? '<br>Attn: ' + esc(s.contact) : ''}${s?.email ? '<br>' + esc(s.email) : ''}${s?.phone ? '<br>' + esc(s.phone) : ''}</div>
  <div><b>RFQ No:</b> ${esc(rfq.number)}<br><b>Date:</b> ${fmtDate(new Date())}<br><b>Project:</b> ${esc(project.name)}${rfq.due_date ? `<br><b>Reply by:</b> ${fmtDate(rfq.due_date)}` : ''}</div></div>
  <p>Please quote your best unit prices for the following items${project.site_address ? `, delivered to <b>${esc(project.site_address)}</b>` : ''}.</p>
  <table><thead><tr><th>#</th><th>Item</th><th>Specification / size</th><th class="n">Qty</th><th>Unit</th><th class="n">Unit price (E)</th><th class="n">Total (E)</th></tr></thead><tbody>
  ${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td>${esc(l.spec || '')}</td><td class="n">${fmt(l.qty, 2)}</td><td>${esc(l.unit)}</td><td></td><td></td></tr>`).join('')}
  </tbody></table>
  <div class="box">${esc(rfq.notes || 'Please quote unit prices excluding VAT, with availability and lead time.').replace(/\n/g, '<br>')}</div>
  <p style="margin-top:18px">Kind regards,<br><b>Du Green Procurement</b></p>`, rfq.number);
}

export function openPoDoc(po, lines, project, s) {
  const vat = Number(po.vat_rate ?? 0.15);
  const sub = lines.reduce((t, l) => t + Number(l.qty) * Number(l.unit_price), 0);
  open(`${head('Purchase Order')}
  <div class="meta"><div><b>Supplier:</b> ${esc(s?.name || '')}${s?.contact ? '<br>Attn: ' + esc(s.contact) : ''}${s?.email ? '<br>' + esc(s.email) : ''}${s?.phone ? '<br>' + esc(s.phone) : ''}</div>
  <div><b>PO No:</b> ${esc(po.number)}<br><b>Date:</b> ${fmtDate(po.po_date)}<br><b>Project:</b> ${esc(project.name)}${project.code ? ' (' + esc(project.code) + ')' : ''}<br><b>Deliver to:</b> ${esc(po.delivery || '')}</div></div>
  <table><thead><tr><th>#</th><th>Item</th><th>Specification</th><th class="n">Qty</th><th>Unit</th><th class="n">Unit price (E)</th><th class="n">Total (E)</th></tr></thead><tbody>
  ${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td>${esc(l.spec || '')}</td><td class="n">${fmt(l.qty, 2)}</td><td>${esc(l.unit)}</td><td class="n">${fmt(l.unit_price, 2)}</td><td class="n">${fmt(l.qty * l.unit_price, 2)}</td></tr>`).join('')}
  <tr class="tot"><td colspan="6">Subtotal</td><td class="n">${fmt(sub, 2)}</td></tr><tr><td colspan="6">VAT ${fmt(vat * 100)}%</td><td class="n">${fmt(sub * vat, 2)}</td></tr><tr class="tot"><td colspan="6">Total (E)</td><td class="n">${fmt(sub * (1 + vat), 2)}</td></tr>
  </tbody></table>
  ${po.notes ? `<div class="box">${esc(po.notes)}</div>` : ''}
  <div class="box">Please quote the PO number on all delivery notes and invoices. Goods are subject to inspection on delivery.</div>
  <div class="sig"><div>Authorised by (Du Green)</div><div>Accepted by (Supplier)</div></div>`, po.number);
}

export function openBoqDoc(project, sections, totals) {
  open(`${head('Bill of Quantities', `<div style="font-size:13px">${esc(project.name)}${project.client ? ' · ' + esc(project.client) : ''}${project.code ? ' · ' + esc(project.code) : ''}</div>`)}
  <table><thead><tr><th>#</th><th>Description</th><th>Unit</th><th class="n">Qty</th><th class="n">Rate (E)</th><th class="n">Amount (E)</th></tr></thead><tbody>
  ${sections.map((s, si) => `<tr class="sec"><td colspan="6">${si + 1}. ${esc(s.name)}</td></tr>` + s.rows.map((r, ri) => `<tr><td>${si + 1}.${ri + 1}</td><td>${esc(r.description)}${r.spec ? `<br><small>${esc(r.spec)}</small>` : ''}</td><td>${esc(r.unit)}</td><td class="n">${fmt(r.qty, 2)}</td><td class="n">${r.sell != null ? fmt(r.sell, 2) : ''}</td><td class="n">${r.sell != null ? fmt(r.sell * r.qty, 2) : ''}</td></tr>`).join('') + `<tr><td></td><td colspan="4"><b>Subtotal ${esc(s.name)}</b></td><td class="n"><b>${fmt(s.total, 2)}</b></td></tr>`).join('')}
  <tr class="tot"><td colspan="5">Total excluding VAT</td><td class="n">${fmt(totals.sell, 2)}</td></tr>
  <tr><td colspan="5">VAT ${fmt(totals.vatRate * 100)}%</td><td class="n">${fmt(totals.sell * totals.vatRate, 2)}</td></tr>
  <tr class="tot"><td colspan="5">Total including VAT</td><td class="n">${fmt(totals.sell * (1 + totals.vatRate), 2)}</td></tr></tbody></table>
  <p style="font-size:11.5px;color:#555;margin-top:14px">All amounts in Emalangeni (E). Prepared ${fmtDate(new Date())}.</p>`, 'BOQ ' + project.name);
}

// ---------------------------------------------------------------- v2 documents
const blankRows = (n, cols) => Array.from({ length: n }, () => `<tr>${'<td style="height:26px"></td>'.repeat(cols)}</tr>`).join('');
const box = (label, text, h = 60) => `<div class="box" style="min-height:${h}px"><b>${esc(label)}</b><div style="white-space:pre-wrap;margin-top:4px">${esc(text || '')}</div></div>`;

export function openPlanDoc(project, title, tasks, D, sup) {
  const byDay = {};
  for (const t of tasks) (byDay[t.day || t.start_date || ''] = byDay[t.day || t.start_date || ''] || []).push(t);
  const rows = tasks[0]?.day ? Object.entries(byDay).map(([d, ts]) => `<tr class="sec"><td colspan="5">${d ? fmtDate(d) + ' · ' + new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long' }) : ''}</td></tr>` + ts.map(t => `<tr><td>${esc(D.areaBy[t.area_id]?.code || '')}</td><td>${esc(t.name)}${t.notes ? `<br><small>${esc(t.notes)}</small>` : ''}</td><td>${esc(D.staffBy[t.supervisor_id]?.name || '')}</td><td class="n">${t.crew || ''}</td><td></td></tr>`).join('')).join('')
    : tasks.map(t => `<tr><td>${esc(D.areaBy[t.area_id]?.code || '')}</td><td>${esc(t.name)}<br><small>${esc(t.phase || '')}</small></td><td>${fmtDate(t.start_date)} – ${fmtDate(t.end_date)}</td><td>${esc(D.staffBy[t.supervisor_id]?.name || '')}</td><td class="n">${fmt(t.status === 'done' ? 100 : t.pct || 0)}%</td></tr>`).join('');
  open(`${head(title, `<div style="font-size:13px">${esc(project.name)}${sup ? ' · Supervisor: ' + esc(sup.name) : ''}</div>`)}
  <table><thead><tr><th>Area</th><th>Task</th><th>${tasks[0]?.day ? 'Supervisor' : 'Dates'}</th><th class="n">${tasks[0]?.day ? 'Crew' : 'Supervisor'}</th><th class="n">${tasks[0]?.day ? 'Done ✓' : 'Complete'}</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No tasks.</td></tr>'}</tbody></table>
  <p style="font-size:11.5px;color:#555;margin-top:14px">Printed ${fmtDate(new Date())}. Record progress on the daily jobcard.</p>`, title);
}

export function openJobcardDoc(project, jc, D) {
  const sup = D.staffBy[jc.supervisor_id];
  const w = jc.weather || {};
  const staff = jc.staff || [];
  open(`${head('Daily Jobcard', `<div style="font-size:13px">${esc(project.name)}${project.code ? ' · ' + esc(project.code) : ''}</div>`)}
  <div class="meta"><div><b>Date:</b> ${fmtDate(jc.card_date)} (${new Date(jc.card_date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long' })})<br><b>Supervisor:</b> ${esc(sup?.name || '')}</div>
    <div><b>Weather AM:</b> ${esc(w.am || '______')} &nbsp; <b>PM:</b> ${esc(w.pm || '______')}<br><b>Rain:</b> ${w.rain_mm ?? '____'} mm &nbsp; <b>Temp:</b> ${w.temp ?? '____'} °C &nbsp; <b>Hours lost:</b> ${w.lost_hours ?? '____'}</div></div>
  <h3 style="margin:10px 0 0;font-size:14px">Staff on site</h3>
  <table><thead><tr><th>Name</th><th>Role</th><th class="n">No.</th><th class="n">Hours</th><th>Sign in</th></tr></thead><tbody>
    ${staff.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.role || '')}</td><td class="n">${s.count || 1}</td><td class="n">${s.hours ?? ''}</td><td></td></tr>`).join('')}${blankRows(Math.max(3, 8 - staff.length), 5)}</tbody></table>
  <h3 style="margin:14px 0 0;font-size:14px">Planned work</h3>
  <table><thead><tr><th>Area</th><th>Task</th><th>Done / part / not started</th><th class="n">%</th><th>Notes</th></tr></thead><tbody>
    ${(jc.tasks || []).map(t => `<tr><td>${esc(t.area || '')}</td><td>${esc(t.name)}</td><td>${esc({ done: 'Done', partial: 'Partly done', not_started: 'Not started' }[t.state] || '')}</td><td class="n">${jc.blank ? '' : t.pct ?? ''}</td><td>${esc(t.notes || '')}</td></tr>`).join('') || '<tr><td colspan="5">Nothing planned.</td></tr>'}</tbody></table>
  <h3 style="margin:14px 0 0;font-size:14px">Other work done</h3>
  <table><thead><tr><th>Area</th><th>Work done</th><th>Notes</th></tr></thead><tbody>
    ${(jc.extra_tasks || []).filter(x => x.text).map(x => `<tr><td>${esc(x.area || '')}</td><td>${esc(x.text)}</td><td>${esc(x.notes || '')}</td></tr>`).join('')}${blankRows(4, 3)}</tbody></table>
  <h3 style="margin:14px 0 0;font-size:14px">Plant & equipment / deliveries</h3>
  <table><thead><tr><th>Plant / equipment</th><th class="n">Hours</th><th>Deliveries received (PO / delivery note)</th></tr></thead><tbody>
    ${Array.from({ length: Math.max(3, (jc.plant || []).length, (jc.deliveries || []).length) }, (_, i) => { const p = (jc.plant || [])[i], d = (jc.deliveries || [])[i]; return `<tr><td style="height:24px">${esc(p?.item || '')}</td><td class="n">${p?.hours ?? ''}</td><td>${d ? esc([d.po_number, d.state === 'full' ? 'in full' : d.state === 'part' ? 'part' : '', d.note].filter(Boolean).join(' · ')) : ''}</td></tr>`; }).join('')}</tbody></table>
  ${box('Issues / delays', jc.issues)}${box('Safety incidents / near misses', jc.safety, 40)}${box('Visitors / instructions received', jc.visitors, 40)}${box('Materials or plant needed', '', 40)}${box('Notes for tomorrow', jc.notes, 40)}
  <div class="sig"><div>${jc.supervisor_sign ? `<img src="${jc.supervisor_sign}" style="height:50px">` : ''}Supervisor</div><div>Site / Contracts Manager</div></div>`, 'Jobcard ' + jc.card_date);
}

export function openSiDoc(project, si, D) {
  const a = D.areaBy[si.area_id];
  open(`${head('Site Instruction', `<div style="font-size:13px">${esc(project.name)}${project.client ? ' · ' + esc(project.client) : ''}</div>`)}
  <div class="meta"><div><b>SI No:</b> ${esc(si.number)}<br><b>Date:</b> ${fmtDate(si.si_date)}<br><b>Area:</b> ${a ? esc((a.code || '') + ' ' + (a.name || '')) : 'Whole site'}</div>
    <div><b>Instructed by:</b> ${esc(si.instructed_by || '')}<br><b>Role:</b> ${esc(si.instructor_role || '')}<br><b>Company:</b> ${esc(si.instructor_company || '')}</div></div>
  ${box('Instruction', si.description, 120)}
  <div class="meta" style="margin-top:12px"><div><b>Cost impact:</b> ${si.cost_impact ? 'Yes' + (si.est_value ? ' · estimated E ' + fmt(si.est_value, 2) + ' excl. VAT' : '') : 'No'}</div><div><b>Time impact:</b> ${si.time_days ? fmt(si.time_days) + ' days' : 'None stated'}</div></div>
  ${si.response ? box('Du Green response', si.response, 40) : ''}
  <p style="font-size:12px;margin-top:14px">Du Green Investments will carry out the above instruction. Any change to cost or programme will be confirmed as a variation.</p>
  <div class="sig"><div>${si.signature ? `<img src="${si.signature}" style="height:60px">` : ''}${esc(si.instructed_by || '')} – ${esc(si.instructor_role || 'Person instructing')}${si.signed_at ? `<br><small>Signed ${new Date(si.signed_at).toLocaleString('en-GB')}</small>` : ''}</div>
    <div><br><br>${esc(si.recorded_by || '')} – Du Green</div></div>`, si.number);
}

export function openReportDoc(project, F, chartHtml) {
  open(`${head('Project Cost Report', `<div style="font-size:13px">${esc(project.name)}${project.client ? ' · ' + esc(project.client) : ''} · ${fmtDate(new Date())}</div>`)}
  <style>.viz{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--line:#ddd;--muted:#666;--ink:#111}.swatch{width:10px;height:10px;display:inline-block;border-radius:2px}.row{display:flex;gap:12px;align-items:center}.small{font-size:12px}</style>
  <table><tbody>
    <tr><td>Contract value (BOQ)</td><td class="n">${money(F.contract)}</td><td>Budget cost</td><td class="n">${money(F.budget)}</td></tr>
    <tr><td>Approved variations</td><td class="n">${money(F.variations)}</td><td>Committed (POs)</td><td class="n">${money(F.committed)}</td></tr>
    <tr><td><b>Revised contract</b></td><td class="n"><b>${money(F.revenue)}</b></td><td><b>Actual cost to date</b></td><td class="n"><b>${money(F.actual)}</b></td></tr>
    <tr><td>Claimed / certified</td><td class="n">${money(F.claimed)} / ${money(F.certified)}</td><td>Forecast final cost</td><td class="n">${money(F.forecast)}</td></tr>
    <tr><td>Paid</td><td class="n">${money(F.paid)}</td><td><b>Forecast margin</b></td><td class="n"><b>${money(F.margin)}${F.marginPct != null ? ' (' + fmt(F.marginPct * 100, 1) + '%)' : ''}</b></td></tr>
    <tr><td>Work complete</td><td class="n">${fmt(F.progress * 100)}%</td><td>Labour</td><td class="n">${fmt(F.personDays, 1)} person-days</td></tr>
  </tbody></table>
  <div style="margin-top:14px">${chartHtml}</div>
  <table><thead><tr><th>Category</th><th class="n">Budget</th><th class="n">Committed</th><th class="n">Actual</th><th class="n">Forecast</th><th class="n">Variance</th></tr></thead><tbody>
  ${F.rows.map(r => `<tr><td>${esc(r.cat)}</td><td class="n">${fmt(r.budget, 2)}</td><td class="n">${fmt(r.committed, 2)}</td><td class="n">${fmt(r.actual, 2)}</td><td class="n">${fmt(r.forecast, 2)}</td><td class="n">${fmt(r.budget - r.forecast, 2)}</td></tr>`).join('')}
  <tr class="tot"><td>Total</td><td class="n">${fmt(F.budget, 2)}</td><td class="n">${fmt(F.committed, 2)}</td><td class="n">${fmt(F.actual, 2)}</td><td class="n">${fmt(F.forecast, 2)}</td><td class="n">${fmt(F.budget - F.forecast, 2)}</td></tr></tbody></table>
  <p style="font-size:11.5px;color:#555;margin-top:14px">All amounts in Emalangeni excluding VAT.</p>`, 'Cost report ' + project.name);
}
