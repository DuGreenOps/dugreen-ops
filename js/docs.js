// Printable documents: RFQ, purchase order and client BOQ (open in a new tab → Print / Save as PDF).
import { CONFIG } from './config.js';
import { esc, fmt, money, fmtDate } from './util.js';

const CSS = `body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#111;margin:0;padding:28px}
.hd{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #2F6A17;padding-bottom:12px;margin-bottom:16px}
.hd img{height:70px}.co{font-size:12px;color:#333;text-align:right}.co b{font-size:15px;color:#111}
h1{font-size:22px;margin:0 0 4px;color:#2F6A17}.meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;margin-bottom:14px;font-size:12.5px}
table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#E8EFE2;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:6px 8px;border-bottom:1px solid #9AB58A}
td{padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top}td.n,th.n{text-align:right;white-space:nowrap}tr.tot td{font-weight:bold;border-top:2px solid #333}tr.sec td{background:#f3f3f3;font-weight:bold}
.box{border:1px solid #ccc;padding:10px 12px;margin-top:14px;font-size:12.5px}.sig{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px;font-size:12px}.sig div{border-top:1px solid #333;padding-top:4px}
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
