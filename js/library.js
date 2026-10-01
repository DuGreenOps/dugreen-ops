// Supplier library: suppliers and every price ever quoted or entered (updated automatically from quotes).
import { esc, fmt, money, dialog, formData, toast, confirmDlg, num, itemKey, today, fmtDate, UNITS, groupBy } from './util.js';

export async function editSupplier(store, s) {
  const v = await dialog({
    title: s ? s.name : 'New supplier',
    body: `<label class="f">Company name<input name="name" required value="${esc(s?.name)}"></label>
      <div class="grid2"><label class="f">Contact person<input name="contact" value="${esc(s?.contact)}"></label>
      <label class="f">Phone / WhatsApp<input name="phone" type="tel" value="${esc(s?.phone)}" placeholder="+268 …"></label></div>
      <label class="f">Email<input name="email" type="email" value="${esc(s?.email)}"></label>
      <label class="f">Supplies<input name="categories" value="${esc(s?.categories)}" placeholder="Plants, instant lawn, irrigation, paving…"></label>
      <label class="f">Notes<textarea name="notes">${esc(s?.notes)}</textarea></label>`,
    buttons: [...(s ? [{ label: 'Delete', danger: true, value: 'delete' }] : []), { label: 'Cancel', value: null }, { label: 'Save', primary: true, value: w => formData(w), validate: w => !!w.querySelector('[name=name]').value.trim() }],
  });
  if (!v) return null;
  if (v === 'delete') { if (await confirmDlg('Delete supplier?', `Delete ${s.name} and all its library prices?`)) { await store.remove('suppliers', s.id); return 'deleted'; } return null; }
  const row = { name: v.name.trim(), contact: v.contact || null, phone: v.phone || null, email: v.email || null, categories: v.categories || null, notes: v.notes || null };
  const out = s ? await store.update('suppliers', s.id, row) : await store.insert('suppliers', row);
  toast('Supplier saved'); return out;
}

export async function render(app, ctx, rest) {
  const { store } = ctx;
  const [suppliers, prices, projects] = await Promise.all([store.list('suppliers', {}, 'name'), store.list('library_prices', {}, 'price_date'), store.list('projects', {}, null)]);
  const sup = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const proj = Object.fromEntries(projects.map(p => [p.id, p]));
  const q = (rest[0] && decodeURIComponent(rest[0])) || '';
  const items = Object.values(groupBy(prices, p => p.item_key)).map(ps => {
    const latest = {}; ps.forEach(p => { const x = latest[p.supplier_id]; if (!x || String(p.price_date) >= String(x.price_date)) latest[p.supplier_id] = p; });
    const cur = Object.values(latest).sort((a, b) => a.unit_price - b.unit_price);
    return { key: ps[0].item_key, description: ps[ps.length - 1].description, spec: ps[ps.length - 1].spec, unit: ps[ps.length - 1].unit, cur, history: ps };
  }).filter(i => !q || (i.description + ' ' + (i.spec || '') + ' ' + i.cur.map(c => sup[c.supplier_id]?.name).join(' ')).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.description.localeCompare(b.description));

  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Procurement</div><h1>Suppliers & price library</h1>
      <p class="small muted" style="margin:4px 0 0">Every supplier quote saved on a project updates this library automatically, so the next job can be priced from it.</p></div></div>
    <section class="card"><div class="hd"><h2>Suppliers</h2><span class="small muted">${suppliers.length}</span><span class="grow"></span><button class="btn primary" id="ns">+ Supplier</button></div>
      ${suppliers.length ? `<div class="tbl"><table><thead><tr><th>Supplier</th><th>Contact</th><th>Supplies</th><th class="n">Prices</th></tr></thead><tbody>
      ${suppliers.map(s => `<tr class="click" data-s="${s.id}"><td><b>${esc(s.name)}</b></td><td class="small">${esc([s.contact, s.phone, s.email].filter(Boolean).join(' · '))}</td><td class="small">${esc(s.categories || '')}</td><td class="n">${prices.filter(p => p.supplier_id === s.id).length}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty"><b>No suppliers yet</b>Add the nurseries, turf farms, quarries and hardware suppliers you buy from.</div>'}</section>
    <section class="card"><div class="hd"><h2>Price library</h2><span class="grow"></span>
      <input id="q" type="search" placeholder="Search items or suppliers" value="${esc(q)}" style="max-width:260px">
      <button class="btn" id="np" ${suppliers.length ? '' : 'disabled'}>+ Price</button></div>
      ${items.length ? `<div class="tbl"><table><thead><tr><th>Item</th><th>Unit</th><th>Current prices (latest per supplier)</th><th class="n">History</th></tr></thead><tbody>
      ${items.map(i => `<tr class="click" data-k="${esc(i.key)}"><td><b>${esc(i.description)}</b><div class="small muted">${esc(i.spec || '')}</div></td><td>${esc(i.unit || '')}</td>
        <td class="small">${i.cur.map((c, k) => `<div>${k === 0 ? '<b>' : ''}${money(Number(c.unit_price))}${k === 0 ? '</b>' : ''} · ${esc(sup[c.supplier_id]?.name || '?')} <span class="muted">${fmtDate(c.price_date)}${c.source === 'quote' ? ' · quote' : ''}</span></div>`).join('')}</td>
        <td class="n">${i.history.length}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty">${q ? 'No matches.' : '<b>No prices yet</b>Prices arrive here from supplier quotes, or add one by hand.'}</div>`}</section>
  </div>`;
  app.querySelector('#ns').onclick = async () => { if (await editSupplier(store, null)) ctx.reload(); };
  app.querySelectorAll('[data-s]').forEach(r => r.onclick = async () => { if (await editSupplier(store, sup[r.dataset.s])) ctx.reload(); });
  let t; app.querySelector('#q').oninput = e => { clearTimeout(t); t = setTimeout(() => { location.hash = '#/library/' + encodeURIComponent(e.target.value); }, 350); };
  app.querySelector('#np').onclick = async () => {
    const v = await dialog({
      title: 'Add a price',
      body: `<label class="f">Supplier<select name="s">${suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
        <label class="f">Item<input name="d" required></label><div class="grid2"><label class="f">Spec / size<input name="sp"></label><label class="f">Unit<select name="u">${UNITS.map(u => `<option>${u}</option>`).join('')}</select></label></div>
        <div class="grid2"><label class="f">Unit price (E, excl. VAT)<input name="p" inputmode="decimal" required></label><label class="f">Price date<input name="dt" type="date" value="${today()}"></label></div>`,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, value: w => formData(w), validate: w => !!w.querySelector('[name=d]').value.trim() && num(w.querySelector('[name=p]').value) != null }],
    });
    if (!v) return;
    await store.insert('library_prices', { supplier_id: v.s, item_key: itemKey(v.d, v.sp, v.u), description: v.d.trim(), spec: v.sp || null, unit: v.u, unit_price: num(v.p), price_date: v.dt || today(), source: 'manual' });
    toast('Price added'); ctx.reload();
  };
  app.querySelectorAll('[data-k]').forEach(r => r.onclick = () => {
    const i = items.find(x => x.key === r.dataset.k);
    dialog({ title: i.description, wide: true, body: `<p class="muted">${esc(i.spec || '')} · ${esc(i.unit || '')}</p><div class="tbl"><table><thead><tr><th>Date</th><th>Supplier</th><th>Source</th><th class="n">Unit price</th></tr></thead><tbody>
      ${[...i.history].reverse().map(h => `<tr><td>${fmtDate(h.price_date)}</td><td>${esc(sup[h.supplier_id]?.name || '?')}</td><td class="small">${h.source === 'quote' ? 'Quote' + (proj[h.project_id] ? ' · ' + esc(proj[h.project_id].name) : '') : 'Entered by hand'}</td><td class="n">${money(Number(h.unit_price))}</td></tr>`).join('')}</tbody></table></div>` });
  });
}
