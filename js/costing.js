// Costing & BOQ: cost from the selected supplier price, mark-up set per item (no default ratio),
// selling rates roll into the BOQ by category or by area. Export to Google Sheets (CSV / copy).
import { esc, fmt, money, toast, num, copyText, downloadFile, csvCell, groupBy, CATEGORIES, typeColor } from './util.js';
import { loadProcurement } from './procure.js';
import { computeQty } from './spec.js';
import { sortAreas } from './areas.js';
import { openBoqDoc } from './docs.js';

export async function render(root, ctx) {
  const { store, project } = ctx;
  const by = ctx.rest?.[0] === 'area' ? 'area' : 'category';
  const [D, costRows] = await Promise.all([loadProcurement(store, project), store.list('costing', { project_id: project.id }, null)]);
  const cost = Object.fromEntries(costRows.map(c => [c.item_key, c]));
  const vatRate = Number(project.vat_rate ?? 0.15);

  const rate = key => {
    const c = cost[key] || {}, s = D.selBy[key];
    const costRate = c.cost_override != null ? Number(c.cost_override) : s ? Number(s.unit_price) : null;
    const sell = c.sell_override != null ? Number(c.sell_override) : costRate != null && c.markup_pct != null ? Math.round(costRate * (1 + Number(c.markup_pct) / 100) * 100) / 100 : null;
    const applied = c.sell_override != null && costRate ? (Number(c.sell_override) / costRate - 1) * 100 : c.markup_pct;
    return { costRate, sell, applied, c, s };
  };
  const rows = D.items.map(i => ({ ...i, ...rate(i.item_key) }));
  const tot = { cost: 0, sell: 0, missingCost: 0, missingMk: 0 };
  rows.forEach(r => { if (r.costRate != null) tot.cost += r.costRate * r.qty; else tot.missingCost++; if (r.sell != null) tot.sell += r.sell * r.qty; else if (r.costRate != null) tot.missingMk++; });
  const margin = tot.sell ? (tot.sell - tot.cost) / tot.sell : 0;

  root.innerHTML = `<div class="page">
    <div class="row"><div class="grow"><div class="eyebrow">QS · Matt</div><h2 style="font-size:24px">Costing & BOQ</h2>
      <p class="small muted" style="margin:2px 0 0">Cost comes from the price Procurement selected. Set a mark-up % on cost, or a fixed selling rate, for each item. There is no default ratio.</p></div>
      <div class="row"><button class="btn" id="copy">Copy table</button><button class="btn" id="csv">Download for Google Sheets</button><button class="btn primary" id="boq">Client BOQ</button></div></div>
    <div class="kpis">
      <div class="kpi"><div class="k">Cost</div><div class="v">${money(tot.cost, 0)}</div></div>
      <div class="kpi"><div class="k">Selling excl. VAT</div><div class="v">${money(tot.sell, 0)}</div></div>
      <div class="kpi"><div class="k">Gross profit</div><div class="v">${money(tot.sell - tot.cost, 0)} <span class="small muted">${fmt(margin * 100, 1)}%</span></div></div>
      <div class="kpi"><div class="k">Incl. VAT ${fmt(vatRate * 100)}%</div><div class="v">${money(tot.sell * (1 + vatRate), 0)}</div></div>
    </div>
    ${tot.missingCost || tot.missingMk ? `<div class="note warn">${tot.missingCost ? `<b>${tot.missingCost}</b> items have no cost yet (price them in Procurement or type a cost here). ` : ''}${tot.missingMk ? `<b>${tot.missingMk}</b> items need a mark-up or selling rate.` : ''}</div>` : ''}
    <div class="subtabs"><a href="#/p/${project.id}/costing" class="${by === 'category' ? 'on' : ''}">By category (mark-up here)</a><a href="#/p/${project.id}/costing/area" class="${by === 'area' ? 'on' : ''}">BOQ by area</a></div>
    <section class="card"><div class="tbl" id="tbl"></div></section>
  </div>`;
  const tbl = root.querySelector('#tbl');

  if (by === 'category') {
    const cats = groupBy(rows, r => r.category || 'Other');
    const order = Object.keys(cats).sort((a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b));
    tbl.innerHTML = rows.length ? `<table><thead><tr><th>Item</th><th class="n">Qty</th><th>Unit</th><th class="n">Cost rate</th><th>Supplier</th><th class="n">Mark-up %</th><th class="n">Fixed sell rate</th><th class="n">Sell rate</th><th class="n">Total sell</th><th class="n">Profit</th></tr></thead><tbody>
      ${order.map(c => `<tr class="sec"><td colspan="10">${esc(c)}</td></tr>` + cats[c].map(r => `<tr>
        <td><b>${esc(r.description)}</b>${r.spec ? `<div class="small muted">${esc(r.spec)}</div>` : ''}</td><td class="n">${fmt(r.qty, 2)}</td><td>${esc(r.unit)}</td>
        <td class="n"><input class="num" data-k="${esc(r.item_key)}" data-f="cost_override" inputmode="decimal" value="${r.c.cost_override ?? ''}" placeholder="${r.s ? fmt(r.s.unit_price, 2) : 'cost'}" aria-label="Cost rate for ${esc(r.description)}" title="Leave blank to use the selected supplier price"></td>
        <td class="small">${r.s ? esc(D.sup[r.s.supplier_id]?.name || '') : '<span class="flag">not priced</span>'}</td>
        <td class="n"><input class="num" style="width:76px" data-k="${esc(r.item_key)}" data-f="markup_pct" inputmode="decimal" value="${r.c.markup_pct ?? ''}" aria-label="Mark-up percent for ${esc(r.description)}"></td>
        <td class="n"><input class="num" data-k="${esc(r.item_key)}" data-f="sell_override" inputmode="decimal" value="${r.c.sell_override ?? ''}" aria-label="Fixed selling rate for ${esc(r.description)}"></td>
        <td class="n">${r.sell != null ? fmt(r.sell, 2) : (r.costRate != null ? '<span class="flag">set mark-up</span>' : '–')}${r.c.sell_override != null && r.applied != null ? `<div class="small muted">${fmt(r.applied, 1)}%</div>` : ''}</td>
        <td class="n">${r.sell != null ? fmt(r.sell * r.qty, 2) : '–'}</td><td class="n">${r.sell != null && r.costRate != null ? fmt((r.sell - r.costRate) * r.qty, 2) : '–'}</td></tr>`).join('')).join('')}
      <tr class="tot"><td colspan="8">Total excluding VAT</td><td class="n">${fmt(tot.sell, 2)}</td><td class="n">${fmt(tot.sell - tot.cost, 2)}</td></tr></tbody></table>`
      : '<div class="empty"><b>Nothing to cost yet</b>Specify items first, then price them in Procurement.</div>';
    tbl.querySelectorAll('input[data-k]').forEach(i => i.onchange = async () => {
      const k = i.dataset.k, cur = cost[k] || {};
      const row = { project_id: project.id, item_key: k, markup_pct: cur.markup_pct ?? null, sell_override: cur.sell_override ?? null, cost_override: cur.cost_override ?? null };
      row[i.dataset.f] = num(i.value);
      await store.upsert('costing', row, 'project_id,item_key');
      ctx.reload();
    });
  } else {
    const areas = sortAreas(D.areas);
    const groups = [...areas.map(a => ({ a, lines: D.spec.filter(s => s.area_id === a.id) })), { a: null, lines: D.spec.filter(s => !s.area_id) }].filter(g => g.lines.length);
    let grand = 0;
    tbl.innerHTML = groups.length ? `<table><thead><tr><th>Item</th><th class="n">Qty</th><th>Unit</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead><tbody>
      ${groups.map(g => {
        let st = 0;
        const body = g.lines.map(l => { const q = computeQty(l, g.a); const r = rate(l.item_key); const amt = r.sell != null ? r.sell * q : null; st += amt || 0; return `<tr><td>${esc(l.description)}${l.spec ? `<div class="small muted">${esc(l.spec)}</div>` : ''}</td><td class="n">${fmt(q, 2)}</td><td>${esc(l.unit)}</td><td class="n">${r.sell != null ? fmt(r.sell, 2) : '<span class="flag">–</span>'}</td><td class="n">${amt != null ? fmt(amt, 2) : '–'}</td></tr>`; }).join('');
        grand += st;
        return `<tr class="sec"><td colspan="5">${g.a ? `<span class="code" style="background:${typeColor(g.a.type)}">${esc(g.a.code || '')}</span> ${esc(g.a.name || g.a.type || '')}` : 'Site-wide'}</td></tr>${body}<tr><td colspan="4"><b>Subtotal</b></td><td class="n"><b>${fmt(st, 2)}</b></td></tr>`;
      }).join('')}
      <tr class="tot"><td colspan="4">Total excluding VAT</td><td class="n">${fmt(grand, 2)}</td></tr></tbody></table>` : '<div class="empty"><b>Nothing specified yet</b></div>';
  }

  // ---- exports
  const header = ['Item Key', 'Category', 'Description', 'Spec', 'Unit', 'Total Qty', 'Cost Rate', 'Supplier', 'Mark-up %', 'Fixed Selling Rate', 'Selling Rate', 'Total Cost', 'Total Selling', 'Profit'];
  const data = rows.map(r => [r.item_key, r.category, r.description, r.spec || '', r.unit, +r.qty.toFixed(2), r.costRate ?? '', r.s ? D.sup[r.s.supplier_id]?.name || '' : '', r.c.markup_pct ?? '', r.c.sell_override ?? '', r.sell ?? '',
    r.costRate != null ? +(r.costRate * r.qty).toFixed(2) : '', r.sell != null ? +(r.sell * r.qty).toFixed(2) : '', r.sell != null && r.costRate != null ? +((r.sell - r.costRate) * r.qty).toFixed(2) : '']);
  root.querySelector('#copy').onclick = async () => { (await copyText([header, ...data].map(r => r.join('\t')).join('\n'))) ? toast('Copied. Paste into a Google Sheet.') : toast('Copy failed on this device.'); };
  root.querySelector('#csv').onclick = () => {
    const name = `${(project.code || project.name).replace(/[^A-Za-z0-9]+/g, '_')}_costing.csv`;
    downloadFile(name, '﻿' + [header, ...data].map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv');
    toast('Downloaded. In Google Drive: New → File upload, then open with Google Sheets.');
  };
  root.querySelector('#boq').onclick = () => {
    const sections = Object.entries(groupBy(rows, r => r.category || 'Other')).sort((a, b) => CATEGORIES.indexOf(a[0]) - CATEGORIES.indexOf(b[0]))
      .map(([name, rs]) => ({ name, rows: rs, total: rs.reduce((t, r) => t + (r.sell != null ? r.sell * r.qty : 0), 0) }));
    openBoqDoc(project, sections, { sell: tot.sell, vatRate });
  };
}
