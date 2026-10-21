// Equipment care: damage / breakdown reports with photos, servicing of motorised machines (hours from the
// jobcards), stock takes (planned or random) and quality inspections with checklists.
import { esc, fmt, money, dialog, formData, toast, confirmDlg, num, today, fmtDate, daysBetween, uid, canStores, EQUIP_ISSUE_KINDS, TOOL_LIST, STOCK_CATS } from './util.js';
import { captureSignature } from './sign.js';
import { photoInput, wirePhoto, photoUrls, thumb } from './photos.js';
import { head, open } from './docs.js';
import { qtyAt, locOf, locName } from './stores.js';

export const ISSUE_STATUS = { open: 'Reported', in_repair: 'In repair', repaired: 'Repaired', written_off: 'Written off', closed: 'Closed' };
export const issuePill = s => `<span class="pill ${{ open: 'bad', in_repair: 'warn', repaired: 'ok', written_off: 'mute', closed: 'mute' }[s] || 'mute'}">${esc(ISSUE_STATUS[s] || s)}</span>`;

// ------------------------------------------------------------ report damage
// opts: { asset, item, itemName, tag, projectId, kind }
export async function reportIssue(ctx, S, opts = {}) {
  const { store, me } = ctx;
  const photos = [];
  const a = opts.asset || (opts.tag && S?.assets.find(x => x.tag_no.toLowerCase() === String(opts.tag).toLowerCase())) || null;
  const it = opts.item || (a && S?.itemBy[a.item_id]) || null;
  const v = await dialog({
    title: 'Report damage or a breakdown', sticky: true,
    body: `<div class="grid2"><label class="f">Tool / equipment<input name="item_name" list="dl-eq" value="${esc(it?.name || opts.itemName || '')}" required></label><label class="f">ID number (if it has one)<input name="tag" list="dl-tags" value="${esc(a?.tag_no || opts.tag || '')}"></label></div>
      <datalist id="dl-eq">${[...new Set([...(S?.items || []).map(i => i.name), ...TOOL_LIST])].map(n => `<option>${esc(n)}</option>`).join('')}</datalist>
      <datalist id="dl-tags">${(S?.assets || []).map(x => `<option value="${esc(x.tag_no)}">${esc(S.itemBy[x.item_id]?.name || '')}</option>`).join('')}</datalist>
      <label class="f">What happened<select name="kind">${EQUIP_ISSUE_KINDS.map(k => `<option ${opts.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label class="f">Details<textarea name="description" rows="3" placeholder="e.g. Handle snapped while breaking ground in G2; brushcutter won't start, pull cord broken"></textarea></label>
      <div class="row">${photoInput('ip', '📷 Add photo', true)}<span id="ipv" class="row" style="gap:6px"></span></div>
      <label class="f">Reported by<input name="by" value="${esc(me?.full_name || '')}"></label>`,
    onOpen: w => wirePhoto(w, 'ip', store, 'equipment', p => { photos.push(p); w.querySelector('#ipv').insertAdjacentHTML('beforeend', thumb(p.url, 'Damage photo', 56)); }),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Report', primary: true, value: w => formData(w), validate: w => !!w.querySelector('[name=item_name]').value.trim() }],
  });
  if (!v) return null;
  const asset = a || (v.tag && S?.assets.find(x => x.tag_no.toLowerCase() === v.tag.trim().toLowerCase())) || null;
  const row = { asset_id: asset?.id || null, item_id: asset?.item_id || it?.id || S?.items.find(i => i.name.toLowerCase() === v.item_name.trim().toLowerCase())?.id || null, item_name: v.item_name.trim(), tag_no: (asset?.tag_no || v.tag || '').trim() || null,
    project_id: opts.projectId || asset?.project_id || null, kind: v.kind, description: v.description || null, photos: photos.map(p => ({ path: p.path, at: p.at })), reported_by: v.by || null, status: 'open' };
  const out = await store.insert('equipment_issues', row);
  if (asset && ['Broken', 'Breakdown'].includes(v.kind)) await store.update('assets', asset.id, { condition: 'Poor' });
  if (asset && ['Lost', 'Stolen'].includes(v.kind)) await store.update('assets', asset.id, { status: 'lost' });
  toast('Reported to Procurement'); return out;
}

export async function issuesView(el, ctx, S) {
  const { store, me } = ctx, can = canStores(me);
  const list = [...S.issues].sort((a, b) => (a.status === 'open' ? 0 : a.status === 'in_repair' ? 1 : 2) - (b.status === 'open' ? 0 : b.status === 'in_repair' ? 1 : 2) || String(b.created_at).localeCompare(String(a.created_at)));
  const urls = await photoUrls(store, list.flatMap(i => (i.photos || []).slice(0, 1).map(p => p.path)));
  el.innerHTML = `<section class="card"><div class="hd"><h3>Damage, breakdowns & repairs</h3><span class="grow"></span><button class="btn small primary" id="rep">+ Report damage</button></div>
    ${list.length ? `<div class="tbl"><table><thead><tr><th></th><th>Item</th><th>What happened</th><th>Where</th><th>Reported</th><th>Status</th></tr></thead><tbody>${list.map(i => `<tr class="click" data-i="${i.id}"><td>${thumb(urls[i.photos?.[0]?.path], 'Photo', 44)}</td><td><b>${esc(i.item_name || '')}</b>${i.tag_no ? `<div class="small muted">${esc(i.tag_no)}</div>` : ''}</td>
      <td><b>${esc(i.kind)}</b><div class="small muted">${esc((i.description || '').slice(0, 90))}</div></td><td class="small">${esc(S.projBy[i.project_id]?.name || 'Stores')}</td><td class="small">${fmtDate(i.created_at)}<div class="muted">${esc(i.reported_by || '')}</div></td><td>${issuePill(i.status)}${i.cost ? `<div class="small muted">${money(Number(i.cost), 0)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty"><b>Nothing reported</b>Supervisors report damaged or broken tools from the jobcard; Procurement can report here.</div>'}</section>`;
  el.querySelector('#rep').onclick = async () => { if (await reportIssue(ctx, S, {})) ctx.reload(); };
  el.querySelectorAll('[data-i]').forEach(r => r.onclick = async () => { if (await manageIssue(ctx, S, S.issues.find(x => x.id === r.dataset.i), can)) ctx.reload(); });
}

async function manageIssue(ctx, S, x, can) {
  const { store } = ctx;
  const urls = await photoUrls(store, (x.photos || []).map(p => p.path));
  const v = await dialog({
    title: `${x.item_name}${x.tag_no ? ' · ' + x.tag_no : ''}`, wide: true,
    body: `<div class="row">${issuePill(x.status)}<b>${esc(x.kind)}</b><span class="small muted">${fmtDate(x.created_at)} · ${esc(x.reported_by || '')} · ${esc(S.projBy[x.project_id]?.name || 'Stores')}</span></div>
      <p>${esc(x.description || '')}</p><div class="row" style="gap:8px">${(x.photos || []).map(p => urls[p.path] ? `<a href="${urls[p.path]}" target="_blank" rel="noopener">${thumb(urls[p.path], 'Damage photo', 120)}</a>` : '').join('')}</div>
      ${can ? `<div class="grid3" style="margin-top:10px"><label class="f">Status<select name="status">${Object.entries(ISSUE_STATUS).map(([k, l]) => `<option value="${k}" ${x.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label class="f">Repair cost (E)<input name="cost" inputmode="decimal" value="${x.cost ?? ''}"></label><label class="f">Repaired by<input name="repairer" value="${esc(x.repairer || '')}"></label></div>
        <label class="f">Action taken<input name="action" value="${esc(x.action || '')}" placeholder="e.g. new handle fitted; sent to agent for carburettor repair"></label>
        <label class="chk"><input type="checkbox" name="charge" ${x.charge_to ? 'checked' : ''}> Charge to the person responsible (PPE / tool policy)</label>` : `<p class="small muted">${esc(x.action || '')}</p>`}`,
    buttons: [{ label: 'Close', value: null }, ...(can ? [{ label: 'Save', primary: true, value: w => formData(w) }] : [])],
  });
  if (!v) return null;
  await store.update('equipment_issues', x.id, { status: v.status, cost: num(v.cost), repairer: v.repairer || null, action: v.action || null, charge_to: v.charge ? (x.reported_by || 'yes') : null, resolved_at: ['repaired', 'written_off', 'closed'].includes(v.status) ? new Date().toISOString() : null });
  const a = x.asset_id && S.assetBy[x.asset_id];
  if (a) {
    if (v.status === 'in_repair') await store.update('assets', a.id, { status: 'repair' });
    if (v.status === 'repaired') await store.update('assets', a.id, { status: a.project_id ? 'site' : a.person_id ? 'person' : 'store', condition: 'Good' });
    if (v.status === 'written_off') await store.update('assets', a.id, { status: 'written_off' });
  }
  toast('Saved'); return true;
}

// ---------------------------------------------------------------- servicing
export function serviceDue(S, a) {
  const it = S.itemBy[a.item_id]; if (!it || it.kind !== 'machine' || (!it.service_hours && !it.service_days)) return null;
  const last = S.services.filter(s => s.asset_id === a.id).sort((x, y) => String(y.service_date).localeCompare(String(x.service_date)))[0];
  const hrs = (Number(a.hours) || 0) - (Number(last?.hours_at) || 0);
  const since = last?.service_date || a.purchase_date || (a.created_at || '').slice(0, 10) || today();
  const days = daysBetween(since, today());
  const hp = it.service_hours ? hrs / it.service_hours : 0, dp = it.service_days ? days / it.service_days : 0, p = Math.max(hp, dp);
  return { state: p >= 1 ? 'due' : p >= 0.8 ? 'soon' : 'ok', hrs, days, last, text: [it.service_hours ? `${fmt(hrs, 0)}/${it.service_hours} h` : '', it.service_days ? `${days}/${it.service_days} days` : ''].filter(Boolean).join(' · ') };
}
export const duePill = d => `<span class="pill ${{ due: 'bad', soon: 'warn', ok: 'ok' }[d.state]}" title="${esc(d.text)}">${{ due: 'Service due', soon: 'Service soon', ok: 'Service OK' }[d.state]}</span>`;

export async function recordService(ctx, S, a) {
  const { store, me } = ctx;
  const v = await dialog({
    title: `Record service – ${a.tag_no}`,
    body: `<div class="grid3"><label class="f">Date<input type="date" name="d" value="${today()}"></label><label class="f">Hours meter<input name="h" inputmode="decimal" value="${a.hours ?? 0}"></label><label class="f">Cost (E)<input name="c" inputmode="decimal"></label></div>
      <label class="f">Work done<input name="w" placeholder="e.g. Oil change, air filter, spark plug, blade sharpened"></label><label class="f">Done by<input name="by" placeholder="in-house / agent"></label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, value: w => formData(w) }],
  });
  if (!v) return null;
  await store.insert('services', { asset_id: a.id, service_date: v.d || today(), hours_at: num(v.h), work: v.w || null, cost: num(v.c), done_by: v.by || null, recorded_by: me?.full_name || null });
  if (num(v.h) != null) await store.update('assets', a.id, { hours: num(v.h) });
  toast('Service recorded'); return true;
}

export function serviceView(el, ctx, S) {
  const { me } = ctx, can = canStores(me);
  const machines = S.assets.filter(a => S.itemBy[a.item_id]?.kind === 'machine' && !['written_off', 'lost'].includes(a.status)).map(a => ({ a, d: serviceDue(S, a) })).sort((x, y) => ({ due: 0, soon: 1, ok: 2 }[x.d?.state] ?? 3) - ({ due: 0, soon: 1, ok: 2 }[y.d?.state] ?? 3));
  const fuel = {}; // litres per asset from jobcard allocations are added by the jobcard into asset.fuel_l
  el.innerHTML = `<section class="card"><div class="hd"><h3>Fleet & motorised equipment</h3><span class="small muted">Hours come from the jobcards. Set the service interval on the stock item.</span></div>
    ${machines.length ? `<div class="tbl"><table><thead><tr><th>ID no.</th><th>Machine</th><th>Where</th><th class="n">Hours</th><th class="n">Fuel used (L)</th><th>Since last service</th><th>Service</th><th></th></tr></thead><tbody>${machines.map(({ a, d }) => `<tr><td><b>${esc(a.tag_no)}</b></td><td>${esc(S.itemBy[a.item_id]?.name || '')}<div class="small muted">${esc(a.make_model || '')}</div></td><td class="small">${esc(S.projBy[a.project_id]?.name || (a.status === 'store' ? 'Central Stores' : ''))}</td>
      <td class="n">${fmt(a.hours || 0, 1)}</td><td class="n">${fmt(a.fuel_l || 0, 1)}</td><td class="small">${d ? esc(d.text) : '<span class="muted">no interval set</span>'}${d?.last ? `<div class="muted">last ${fmtDate(d.last.service_date)}</div>` : ''}</td><td>${d ? duePill(d) : ''}</td><td class="n">${can ? `<button class="btn small" data-s="${a.id}">Record service</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty"><b>No motorised machines with ID numbers yet</b>Add mowers, brushcutters, the TLB, bakkies etc. as stock items of kind “Machine”, set a service interval, and give each one an ID number.</div>'}</section>`;
  el.querySelectorAll('[data-s]').forEach(b => b.onclick = async () => { if (await recordService(ctx, S, S.assetBy[b.dataset.s])) ctx.reload(); });
}

// --------------------------------------------------------------- stock takes
const locChoices = S => [['store', 'Central Stores'], ...S.projects.filter(p => p.status !== 'complete').map(p => ['project:' + p.id, p.name])];

export async function stocktakeView(el, ctx, S, id) {
  const { store, me } = ctx, can = canStores(me);
  const list = await store.list('stocktakes', {}, 'created_at');
  if (id) return stocktakeSheet(el, ctx, S, list.find(s => s.id === id));
  el.innerHTML = `<section class="card"><div class="hd"><h3>Stock takes</h3><span class="small muted">Planned: count everything at a location. Random: spot-check a sample.</span><span class="grow"></span>${can ? '<button class="btn small primary" id="new">+ New stock take</button>' : ''}</div>
    ${list.length ? `<div class="tbl"><table><thead><tr><th>No.</th><th>Where</th><th>Type</th><th class="n">Lines</th><th class="n">Variances</th><th>Status</th></tr></thead><tbody>${[...list].reverse().map(s => { const vr = (s.lines || []).filter(l => l.counted != null && Number(l.counted) !== Number(l.expected)).length; return `<tr class="click" data-s="${s.id}"><td><b>${esc(s.number)}</b><div class="small muted">${fmtDate(s.st_date)}</div></td><td>${esc(locName(S, s.loc))}</td><td>${s.kind === 'random' ? 'Random' : 'Planned'}</td><td class="n">${(s.lines || []).length}</td><td class="n" style="${vr ? 'color:var(--bad)' : ''}">${s.status === 'draft' ? '–' : vr}</td><td>${s.status === 'draft' ? '<span class="pill warn">Counting</span>' : s.adjusted ? '<span class="pill ok">Posted</span>' : '<span class="pill info">Counted</span>'}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="empty small">No stock takes yet.</div>'}</section>`;
  el.querySelectorAll('[data-s]').forEach(r => r.onclick = () => ctx.go('#/stores/stocktake/' + r.dataset.s));
  el.querySelector('#new')?.addEventListener('click', async () => {
    const v = await dialog({
      title: 'New stock take',
      body: `<div class="grid2"><label class="f">Where<select name="loc">${locChoices(S).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label><label class="f">Type<select name="kind"><option value="planned">Planned – everything</option><option value="random">Random spot check</option></select></label></div>
        <div class="grid2"><label class="f">Sample size (random)<input name="n" inputmode="numeric" value="10"></label><label class="f">Category<select name="cat"><option value="">All categories</option>${STOCK_CATS.map(c => `<option>${c}</option>`).join('')}</select></label></div>`,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Create count sheet', primary: true, value: w => formData(w) }],
    });
    if (!v) return;
    let lines = [];
    for (const it of S.items.filter(i => i.active !== false && (!v.cat || i.category === v.cat))) {
      const q = qtyAt(S, it.id, v.loc);
      if (q > 0 || (v.loc === 'store' && !S.assets.some(a => a.item_id === it.id))) lines.push({ item_id: it.id, name: it.name, unit: it.unit || 'each', expected: q, counted: null });
      for (const a of S.assets.filter(a => a.item_id === it.id && locOf(a) === v.loc && !['lost', 'written_off'].includes(a.status))) lines.push({ item_id: it.id, asset_id: a.id, name: it.name, tag: a.tag_no, unit: 'each', expected: 1, counted: null });
    }
    if (v.kind === 'random') { lines = lines.sort(() => Math.random() - 0.5).slice(0, Math.max(1, num(v.n) || 10)); }
    lines.sort((a, b) => a.name.localeCompare(b.name) || String(a.tag || '').localeCompare(String(b.tag || ''), undefined, { numeric: true }));
    if (!lines.length) return toast('Nothing recorded at that location');
    const all = await store.list('stocktakes', {}, null);
    const st = await store.insert('stocktakes', { number: `ST-${new Date().getFullYear()}-${String(all.length + 1).padStart(3, '0')}`, st_date: today(), kind: v.kind, loc: v.loc, lines, status: 'draft', created_by_name: me?.full_name || null });
    ctx.go('#/stores/stocktake/' + st.id);
  });
}

function stocktakeSheet(el, ctx, S, st) {
  const { store, me } = ctx, can = canStores(me);
  if (!st) { el.innerHTML = '<div class="card empty">Stock take not found.</div>'; return; }
  const locked = st.status !== 'draft';
  const draw = () => {
    const vr = st.lines.filter(l => l.counted != null && l.counted !== '' && Number(l.counted) !== Number(l.expected));
    el.innerHTML = `<section class="card"><div class="hd"><div class="grow"><div class="small muted"><a href="#/stores/stocktake">Stock takes</a> /</div><h3>${esc(st.number)} · ${esc(locName(S, st.loc))}</h3><div class="small muted">${st.kind === 'random' ? 'Random spot check' : 'Planned count'} · ${fmtDate(st.st_date)}</div></div>
        <button class="btn" id="pr">Print count sheet</button></div>
      <div class="tbl"><table><thead><tr><th>Item</th><th>ID no.</th><th class="n">Expected</th><th class="n">Counted</th><th>Condition</th><th>Note</th></tr></thead><tbody>
      ${st.lines.map((l, i) => { const off = l.counted != null && l.counted !== '' && Number(l.counted) !== Number(l.expected); return `<tr${off ? ' style="background:color-mix(in srgb,var(--bad) 10%,transparent)"' : ''}><td>${esc(l.name)}</td><td><b>${esc(l.tag || '')}</b></td><td class="n">${fmt(l.expected, 2)} ${esc(l.unit || '')}</td>
        <td class="n">${l.asset_id ? `<select data-c="${i}" ${locked ? 'disabled' : ''}><option value="">–</option><option value="1" ${String(l.counted) === '1' ? 'selected' : ''}>Present</option><option value="0" ${String(l.counted) === '0' ? 'selected' : ''}>Missing</option></select>` : `<input class="num" style="width:80px" data-c="${i}" inputmode="decimal" value="${l.counted ?? ''}" ${locked ? 'disabled' : ''}>`}</td>
        <td><select data-k="${i}" ${locked ? 'disabled' : ''}><option value="">–</option>${['Good', 'Fair', 'Poor', 'Damaged'].map(c => `<option ${l.condition === c ? 'selected' : ''}>${c}</option>`).join('')}</select></td><td><input data-n="${i}" value="${esc(l.note || '')}" ${locked ? 'disabled' : ''}></td></tr>`; }).join('')}</tbody></table></div>
      <div class="bd row"><span class="grow small ${vr.length ? 'flag' : 'muted'}">${vr.length ? `${vr.length} variance${vr.length === 1 ? '' : 's'}` : 'No variances so far.'}</span>
        ${!locked ? '<button class="btn" id="save">Save</button><button class="btn primary" id="done">Finish & sign</button>' : ''}
        ${locked && !st.adjusted && can ? '<button class="btn primary" id="post">Post adjustments to stock</button>' : ''}${st.adjusted ? '<span class="pill ok">Adjustments posted</span>' : ''}</div></section>`;
    const read = () => { el.querySelectorAll('[data-c]').forEach(i => { st.lines[+i.dataset.c].counted = i.value === '' ? null : num(i.value); }); el.querySelectorAll('[data-k]').forEach(i => { st.lines[+i.dataset.k].condition = i.value || null; }); el.querySelectorAll('[data-n]').forEach(i => { st.lines[+i.dataset.n].note = i.value; }); };
    el.querySelectorAll('[data-c],[data-k]').forEach(i => i.onchange = () => { read(); setTimeout(draw, 0); });
    el.querySelector('#pr').onclick = () => open(`${head(st.kind === 'random' ? 'Random Stock Check' : 'Stock Take Count Sheet', `<div style="font-size:13px">${esc(st.number)} · ${esc(locName(S, st.loc))} · ${fmtDate(st.st_date)}</div>`)}
      <table><thead><tr><th>#</th><th>Item</th><th>ID no.</th><th class="n">Expected</th><th>Counted</th><th>Condition</th><th>Note</th></tr></thead><tbody>${st.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.name)}</td><td>${esc(l.tag || '')}</td><td class="n">${fmt(l.expected, 2)} ${esc(l.unit || '')}</td><td style="width:80px">${locked && l.counted != null ? fmt(l.counted, 2) : ''}</td><td style="width:90px">${esc(l.condition || '')}</td><td>${esc(l.note || '')}</td></tr>`).join('')}</tbody></table>
      <div class="sig"><div>${st.sign ? `<img src="${st.sign}" style="height:50px">` : ''}Counted by: ${esc(st.counted_by || '')}</div><div>Checked by (Procurement)</div></div>`, st.number);
    el.querySelector('#save')?.addEventListener('click', async () => { read(); await store.update('stocktakes', st.id, { lines: st.lines }); toast('Saved'); });
    el.querySelector('#done')?.addEventListener('click', async () => {
      read(); const left = st.lines.filter(l => l.counted == null).length;
      if (left && !(await confirmDlg('Some lines not counted', `${left} line${left === 1 ? ' has' : 's have'} no count. Finish anyway?`, 'Finish'))) return;
      const by = me?.full_name || ''; const sig = await captureSignature('Counted by', by); if (!sig) return;
      Object.assign(st, await store.update('stocktakes', st.id, { lines: st.lines, status: 'done', counted_by: by, sign: sig, done_at: new Date().toISOString() })); toast('Stock take finished'); ctx.reload();
    });
    el.querySelector('#post')?.addEventListener('click', async () => {
      if (!(await confirmDlg('Post adjustments?', 'Bulk quantities are corrected to the count. Missing ID-numbered items are marked lost and reported.', 'Post'))) return;
      for (const l of st.lines.filter(l => l.counted != null && Number(l.counted) !== Number(l.expected))) {
        if (l.asset_id) { if (Number(l.counted) === 0) { await store.update('assets', l.asset_id, { status: 'lost' }); await store.insert('equipment_issues', { asset_id: l.asset_id, item_id: l.item_id, item_name: l.name, tag_no: l.tag, project_id: st.loc.startsWith('project:') ? st.loc.split(':')[1] : null, kind: 'Lost', description: `Missing at stock take ${st.number}. ${l.note || ''}`.trim(), reported_by: st.counted_by, status: 'open', photos: [] }); } continue; }
        const d = Number(l.counted) - Number(l.expected);
        await store.insert('stock_moves', { item_id: l.item_id, qty: Math.abs(d), type: 'adjust', from_loc: d > 0 ? 'supplier' : st.loc, to_loc: d > 0 ? st.loc : 'out', move_date: today(), ref: st.number, note: 'Stock take variance', by_name: me?.full_name || null });
      }
      for (const l of st.lines.filter(l => l.asset_id && l.condition)) await store.update('assets', l.asset_id, { condition: l.condition === 'Damaged' ? 'Poor' : l.condition });
      await store.update('stocktakes', st.id, { adjusted: true }); toast('Adjustments posted'); ctx.reload();
    });
  };
  draw();
}

// -------------------------------------------------------------- inspections
export const CHECKLISTS = {
  tool: ['Handle secure, not cracked or splintered', 'Head / blade sound and sharp', 'Clean, no heavy rust', 'Safe to use'],
  machine: ['Guards and covers fitted', 'Starts and runs smoothly', 'No fuel or oil leaks', 'Blade / line / chain in good order', 'Stop switch works', 'Air filter clean', 'Cleaned after use'],
  vehicle: ['Tyres and spare', 'Lights and indicators', 'Brakes', 'Oil and water levels', 'Licence disc valid', 'Clean, no new damage'],
  ppe: ['No tears or damage', 'Correct size for the user', 'Clean'],
};
const checklistFor = it => it?.category === 'Vehicles & plant' ? CHECKLISTS.vehicle : it?.kind === 'machine' ? CHECKLISTS.machine : it?.kind === 'ppe' ? CHECKLISTS.ppe : CHECKLISTS.tool;

export async function inspectView(el, ctx, S, id) {
  const { store, me } = ctx;
  const list = await store.list('inspections', {}, 'created_at');
  if (id) return inspectSheet(el, ctx, S, list.find(x => x.id === id));
  el.innerHTML = `<section class="card"><div class="hd"><h3>Quality inspections</h3><span class="small muted">Checklists for hand tools, machines, vehicles and PPE. Anything that fails is sent to Damage & repairs.</span><span class="grow"></span><button class="btn small primary" id="new">+ New inspection</button></div>
    ${list.length ? `<div class="tbl"><table><thead><tr><th>No.</th><th>Where</th><th class="n">Items</th><th class="n">Failed</th><th>By</th><th>Status</th></tr></thead><tbody>${[...list].reverse().map(x => `<tr class="click" data-x="${x.id}"><td><b>${esc(x.number)}</b><div class="small muted">${fmtDate(x.insp_date)}</div></td><td>${esc(locName(S, x.loc))}</td><td class="n">${(x.lines || []).length}</td><td class="n" style="${(x.lines || []).some(l => l.result && l.result !== 'pass') ? 'color:var(--bad)' : ''}">${(x.lines || []).filter(l => l.result && l.result !== 'pass').length}</td><td class="small">${esc(x.inspector || '')}</td><td>${x.status === 'done' ? '<span class="pill ok">Done</span>' : '<span class="pill warn">In progress</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">No inspections yet.</div>'}</section>`;
  el.querySelectorAll('[data-x]').forEach(r => r.onclick = () => ctx.go('#/stores/inspect/' + r.dataset.x));
  el.querySelector('#new').onclick = async () => {
    const v = await dialog({ title: 'New inspection', body: `<label class="f">Where<select name="loc">${locChoices(S).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label><label class="f">What<select name="what"><option value="all">All ID-numbered items there</option><option value="machine">Machines only</option><option value="tool">Hand tools only</option><option value="ppe">PPE only</option></select></label>`, buttons: [{ label: 'Cancel', value: null }, { label: 'Start', primary: true, value: w => formData(w) }] });
    if (!v) return;
    const lines = S.assets.filter(a => locOf(a) === v.loc && !['lost', 'written_off'].includes(a.status) && (v.what === 'all' || S.itemBy[a.item_id]?.kind === v.what)).map(a => { const it = S.itemBy[a.item_id]; return { asset_id: a.id, item_id: it?.id, name: it?.name || '', tag: a.tag_no, checks: checklistFor(it).map(q => ({ q, ok: null })), result: null, note: '' }; });
    if (!lines.length) return toast('No ID-numbered items there to inspect');
    const all = await store.list('inspections', {}, null);
    const x = await store.insert('inspections', { number: `QI-${new Date().getFullYear()}-${String(all.length + 1).padStart(3, '0')}`, insp_date: today(), loc: v.loc, lines, status: 'draft', inspector: me?.full_name || null });
    ctx.go('#/stores/inspect/' + x.id);
  };
}

function inspectSheet(el, ctx, S, x) {
  const { store, me } = ctx;
  if (!x) { el.innerHTML = '<div class="card empty">Inspection not found.</div>'; return; }
  const locked = x.status === 'done';
  const draw = () => {
    el.innerHTML = `<section class="card"><div class="hd"><div class="grow"><div class="small muted"><a href="#/stores/inspect">Inspections</a> /</div><h3>${esc(x.number)} · ${esc(locName(S, x.loc))}</h3></div><button class="btn" id="pr">Print</button></div>
      <div class="bd stack">${x.lines.map((l, i) => `<div class="dims"><div class="row"><b>${esc(l.tag)}</b> ${esc(l.name)}<span class="grow"></span>
          <select data-r="${i}" style="width:auto" ${locked ? 'disabled' : ''}><option value="">Result…</option><option value="pass" ${l.result === 'pass' ? 'selected' : ''}>Pass</option><option value="repair" ${l.result === 'repair' ? 'selected' : ''}>Needs repair</option><option value="fail" ${l.result === 'fail' ? 'selected' : ''}>Fail – withdraw</option></select></div>
        <div class="row" style="gap:4px 14px">${l.checks.map((c, j) => `<label class="chk"><input type="checkbox" data-q="${i}" data-j="${j}" ${c.ok ? 'checked' : ''} ${locked ? 'disabled' : ''}> ${esc(c.q)}</label>`).join('')}</div>
        <input data-n="${i}" value="${esc(l.note || '')}" placeholder="Note" ${locked ? 'disabled' : ''}></div>`).join('')}
        ${locked ? `<p class="small muted">Inspected by ${esc(x.inspector || '')} on ${fmtDate(x.insp_date)}.</p>` : '<div class="row"><span class="grow small muted">Tick each check that passes. Items marked Needs repair or Fail are reported to Procurement.</span><button class="btn" id="save">Save</button><button class="btn primary" id="done">Finish</button></div>'}</div></section>`;
    const read = () => { el.querySelectorAll('[data-q]').forEach(c => { x.lines[+c.dataset.q].checks[+c.dataset.j].ok = c.checked; }); el.querySelectorAll('[data-r]').forEach(s => { x.lines[+s.dataset.r].result = s.value || null; }); el.querySelectorAll('[data-n]').forEach(n => { x.lines[+n.dataset.n].note = n.value; }); };
    el.querySelectorAll('[data-q]').forEach(c => c.onchange = () => { read(); const l = x.lines[+c.dataset.q]; if (!l.result && l.checks.every(k => k.ok)) { l.result = 'pass'; setTimeout(draw, 0); } });
    el.querySelector('#pr').onclick = () => { read(); open(`${head('Equipment Quality Inspection', `<div style="font-size:13px">${esc(x.number)} · ${esc(locName(S, x.loc))} · ${fmtDate(x.insp_date)}</div>`)}
      <table><thead><tr><th>ID no.</th><th>Item</th><th>Checks</th><th>Result</th><th>Note</th></tr></thead><tbody>${x.lines.map(l => `<tr><td>${esc(l.tag)}</td><td>${esc(l.name)}</td><td style="font-size:11px">${l.checks.map(c => `${c.ok ? '☑' : '☐'} ${esc(c.q)}`).join('<br>')}</td><td>${esc({ pass: 'Pass', repair: 'Needs repair', fail: 'Fail' }[l.result] || '')}</td><td>${esc(l.note || '')}</td></tr>`).join('')}</tbody></table>
      <div class="sig"><div>Inspected by: ${esc(x.inspector || '')}</div><div>Procurement</div></div>`, x.number); };
    el.querySelector('#save')?.addEventListener('click', async () => { read(); await store.update('inspections', x.id, { lines: x.lines }); toast('Saved'); });
    el.querySelector('#done')?.addEventListener('click', async () => {
      read(); const open_ = x.lines.filter(l => !l.result).length;
      if (open_ && !(await confirmDlg('Results missing', `${open_} item${open_ === 1 ? ' has' : 's have'} no result. Finish anyway?`, 'Finish'))) return;
      for (const l of x.lines) {
        if (l.asset_id) await store.update('assets', l.asset_id, { last_inspection: today(), condition: l.result === 'pass' ? 'Good' : l.result ? 'Poor' : undefined });
        if (l.result === 'repair' || l.result === 'fail') await store.insert('equipment_issues', { asset_id: l.asset_id, item_id: l.item_id, item_name: l.name, tag_no: l.tag, project_id: x.loc.startsWith('project:') ? x.loc.split(':')[1] : null, kind: l.result === 'fail' ? 'Worn out' : 'Damaged', description: `Inspection ${x.number}: ${l.checks.filter(c => !c.ok).map(c => c.q).join('; ')}. ${l.note || ''}`.trim(), reported_by: x.inspector, status: 'open', photos: [] });
      }
      await store.update('inspections', x.id, { lines: x.lines, status: 'done' }); toast('Inspection finished'); ctx.reload();
    });
  };
  draw();
}
