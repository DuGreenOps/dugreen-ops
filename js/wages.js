// Wage tickets: days and hours per person from the submitted jobcards for the pay period (26th–25th, as in the
// casual contracts), × the rate from the rates sheet, with EWallet / bank details for payroll.
import { esc, fmt, money, toast, today, fmtDate, copyText, downloadFile, csvCell, canSetRates, PERSON_KINDS, PAY_BASIS, WORKDAYS_PER_MONTH } from './util.js';
import { contractFor, EWALLET_WARNING } from './contracts.js';
import { head, open } from './docs.js';

export function wageRows(P, per) {
  const out = [];
  for (const p of P.people.filter(p => p.kind !== 'subcontractor')) {
    const days = [];
    for (const j of P.jobcards.filter(j => j.status !== 'draft' && j.card_date >= per.from && j.card_date <= per.to)) for (const s of j.staff || []) if (s.staff_id === p.id) days.push({ date: j.card_date, project: P.projBy[j.project_id]?.name || '', hours: Number(s.hours) || 8, sat: new Date(j.card_date + 'T00:00:00Z').getUTCDay() === 6 });
    if (!days.length && p.pay_basis !== 'month') continue;
    if (p.active === false && !days.length) continue;
    days.sort((a, b) => a.date.localeCompare(b.date));
    const hours = days.reduce((t, d) => t + d.hours, 0), dayEq = hours / 8;
    const basis = p.pay_basis || 'day', rate = p.rate != null ? Number(p.rate) : p.day_rate != null ? Number(p.day_rate) : null;
    const gross = rate == null ? null : basis === 'day' ? rate * dayEq : basis === 'hour' ? rate * hours : basis === 'month' ? rate : null;
    const cs = P.contracts.filter(c => c.person_id === p.id && c.status === 'signed').sort((a, b) => String(b.signed_at).localeCompare(String(a.signed_at)));
    const cd = cs[0]?.data || {};
    const method = p.pay_method || cd.pay_method || (cd.ewallet ? 'ewallet' : cd.acc_no ? 'bank' : null);
    const wallet = p.ewallet_no || cd.ewallet, net = p.ewallet_network || cd.ewallet_network, acc = p.acc_no || cd.acc_no, bank = p.bank || cd.bank, branch = p.branch || cd.branch;
    const flags = [];
    if (!contractFor(p.id, P.contracts, null).ok) flags.push('No contract');
    if (!cs.some(c => c.id_photo) && !cs.some(c => c.type === 'upload')) flags.push('No ID copy');
    if (!p.id_no && !cd.id_no) flags.push('No ID number');
    if (method === 'ewallet' ? !wallet : !acc) flags.push('No payment details');
    if (rate == null) flags.push('No rate');
    out.push({ p, days, hours, dayEq, basis, rate, gross, method, wallet, net, acc, bank, branch, idno: p.id_no || cd.id_no || '', flags });
  }
  return out.sort((a, b) => a.p.name.localeCompare(b.p.name));
}

export function wagesView(el, ctx, P, payPeriod) {
  const { me } = ctx, money_ = canSetRates(me);
  let per = payPeriod();
  const draw = () => {
    const rows = wageRows(P, per);
    const total = rows.reduce((t, r) => t + (r.gross || 0), 0), flagged = rows.filter(r => r.flags.length).length;
    el.innerHTML = `<div class="row" style="margin:10px 0;gap:8px;flex-wrap:wrap"><label class="small">Pay period <input type="date" id="pf" value="${per.from}" style="width:auto"> – <input type="date" id="pt" value="${per.to}" style="width:auto"></label><span class="grow"></span>
        <button class="btn small" id="tk">Print wage tickets</button>${money_ ? '<button class="btn small" id="cp">Copy for payroll</button><button class="btn small primary" id="csv">Payroll CSV</button>' : ''}</div>
      <p class="small muted">Days come from submitted jobcards (hours ÷ 8). Work tickets close on the 25th; days after the 25th go into next month.</p>
      ${flagged ? `<div class="note warn"><b>${flagged}</b> ${flagged === 1 ? 'person has' : 'people have'} something missing (contract, ID, payment details or rate). Pay can't be processed without an ID on file.</div>` : ''}
      <section class="card">${rows.length ? `<div class="tbl"><table><thead><tr><th>Name</th><th class="n">Days</th><th class="n">Hours</th><th>Rate</th>${money_ ? '<th class="n">Gross (E)</th>' : ''}<th>Pay to</th><th>Check</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td><b>${esc(r.p.name)}</b><div class="small muted">${esc(PERSON_KINDS[r.p.kind || 'staff'])} · ${esc(r.p.role || '')}${r.idno ? ' · ID ' + esc(r.idno) : ''}</div></td><td class="n">${fmt(r.dayEq, 1)}<div class="small muted">${r.days.length} card${r.days.length === 1 ? '' : 's'}</div></td><td class="n">${fmt(r.hours, 1)}</td>
          <td class="small">${money_ ? (r.rate != null ? money(r.rate) + ' ' + esc((PAY_BASIS[r.basis] || '').replace(/ rate| fee \/ salary/i, '')) : '–') : esc(PAY_BASIS[r.basis] || '')}</td>${money_ ? `<td class="n"><b>${r.gross != null ? fmt(r.gross, 2) : '–'}</b></td>` : ''}
          <td class="small">${r.method === 'ewallet' ? `EWallet ${esc(r.net || '')} ${esc(r.wallet || '')}` : r.acc ? `${esc(r.bank || '')} ${esc(r.acc)}` : '–'}</td><td>${r.flags.length ? r.flags.map(f => `<span class="pill bad">${esc(f)}</span>`).join(' ') : '<span class="pill ok">Ready</span>'}</td></tr>`).join('')}
        ${money_ ? `<tr class="tot"><td colspan="4">Total</td><td class="n">${fmt(total, 2)}</td><td colspan="2"></td></tr>` : ''}</tbody></table></div>` : '<div class="empty small">No one worked in this period according to the submitted jobcards.</div>'}</section>`;
    el.querySelector('#pf').onchange = e => { per.from = e.target.value; draw(); };
    el.querySelector('#pt').onchange = e => { per.to = e.target.value; draw(); };
    const table = () => [['Name', 'ID no.', 'Type', 'Role', 'Days (hours ÷ 8)', 'Hours', 'Saturdays', 'Pay basis', 'Rate (E)', 'Gross (E)', 'Pay to', 'EWallet / bank', 'Number / account', 'Branch', 'Sites', 'Check'],
      ...rows.map(r => [r.p.name, r.idno, PERSON_KINDS[r.p.kind || 'staff'], r.p.role || '', r.dayEq.toFixed(2), r.hours.toFixed(1), r.days.filter(d => d.sat).length, PAY_BASIS[r.basis] || '', r.rate != null ? r.rate.toFixed(2) : '', r.gross != null ? r.gross.toFixed(2) : '', r.method === 'ewallet' ? 'EWallet' : r.method === 'bank' ? 'Bank' : '', r.method === 'ewallet' ? r.net || '' : r.bank || '', r.method === 'ewallet' ? r.wallet || '' : r.acc || '', r.method === 'ewallet' ? '' : r.branch || '', [...new Set(r.days.map(d => d.project))].join('; '), r.flags.join('; ') || 'Ready'])];
    el.querySelector('#cp')?.addEventListener('click', async () => (await copyText(table().map(r => r.join('\t')).join('\n'))) ? toast('Copied – paste into the payroll sheet') : toast('Copy failed'));
    el.querySelector('#csv')?.addEventListener('click', () => downloadFile(`DuGreen_wages_${per.from}_to_${per.to}.csv`, '﻿' + table().map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv'));
    el.querySelector('#tk').onclick = () => open(`${head('Wage Tickets', `<div style="font-size:13px">Pay period ${fmtDate(per.from)} – ${fmtDate(per.to)}</div>`)}
      ${rows.map(r => `<div style="page-break-inside:avoid;border:1px solid #999;padding:10px 12px;margin:12px 0">
        <div class="meta"><div><b>${esc(r.p.name)}</b><br>ID: ${esc(r.idno)}<br>${esc(r.p.role || '')}</div><div>Days: <b>${fmt(r.dayEq, 1)}</b> · Hours: ${fmt(r.hours, 1)}${money_ && r.gross != null ? `<br>Gross: <b>${money(r.gross)}</b>` : ''}<br>Pay to: ${r.method === 'ewallet' ? `EWallet ${esc(r.net || '')} ${esc(r.wallet || '')}` : esc([r.bank, r.acc].filter(Boolean).join(' '))}</div></div>
        <table><thead><tr><th>Date</th><th>Site</th><th class="n">Hours</th><th>Employee signature</th></tr></thead><tbody>${r.days.map(d => `<tr><td>${fmtDate(d.date)}${d.sat ? ' (Sat)' : ''}</td><td>${esc(d.project)}</td><td class="n">${fmt(d.hours, 1)}</td><td style="width:35%"></td></tr>`).join('')}</tbody></table>
        ${r.method === 'ewallet' ? `<p style="font-size:10.5px;margin:6px 0 0">${esc(EWALLET_WARNING)}</p>` : ''}
        <div class="sig" style="margin-top:40px"><div>Employee</div><div>Supervisor / Payroll</div></div></div>`).join('') || '<p>No one worked in this period.</p>'}`, 'Wage tickets');
  };
  draw();
}
