// Reports built from the daily jobcards: progress reports for any period (internal or client copy)
// and the handover report with snag list and client sign-off. The cost report lives in costs.js.
import { esc, fmt, money, dialog, formData, toast, confirmDlg, num, today, fmtDate, addDays, weekStart, groupBy, uid } from './util.js';
import { loadProcurement } from './procure.js';
import { progress, plannedPct, isOverdue, TASK_STATUS } from './pow.js';
import { sortAreas } from './areas.js';
import { areaMeasures } from './geo.js';
import { captureSignature } from './sign.js';
import { head, open } from './docs.js';
import * as Costs from './costs.js';

export async function render(root, ctx) {
  const { project } = ctx;
  const [sub = 'progress'] = ctx.rest || [];
  root.innerHTML = `<div class="page">
    <div class="row"><div class="grow"><div class="eyebrow">Reporting</div><h2 style="font-size:24px">Reports</h2></div>
      <nav class="subtabs"><a href="#/p/${project.id}/reports" class="${sub === 'progress' ? 'on' : ''}">Progress report</a><a href="#/p/${project.id}/reports/handover" class="${sub === 'handover' ? 'on' : ''}">Handover</a><a href="#/p/${project.id}/reports/costs" class="${sub === 'costs' ? 'on' : ''}">Costs</a></nav></div>
    <div id="rv"></div></div>`;
  const el = root.querySelector('#rv');
  if (sub === 'costs') return Costs.render(el, ctx);
  if (sub === 'handover') return handoverView(el, ctx);
  return progressView(el, ctx);
}

async function loadSite(store, project) {
  const [areasRaw, tasks, jobcards, sis, staff, reqs, pos, suppliers, handovers] = await Promise.all([
    store.list('areas', { project_id: project.id }), store.list('tasks', { project_id: project.id }, 'sort'), store.list('jobcards', { project_id: project.id }, 'card_date'),
    store.list('site_instructions', { project_id: project.id }), store.list('staff', {}, 'name'), store.list('requests', { project_id: project.id }),
    store.list('purchase_orders', { project_id: project.id }), store.list('suppliers', {}, 'name'), store.list('handovers', { project_id: project.id }, null)]);
  const areas = sortAreas(areasRaw);
  return { areas, areaBy: Object.fromEntries(areas.map(a => [a.id, a])), tasks, jobcards, sis, staff, staffBy: Object.fromEntries(staff.map(s => [s.id, s])), reqs, pos, sup: Object.fromEntries(suppliers.map(s => [s.id, s])), handover: handovers[0] || null };
}

// Everything the progress report needs for one period, summarised from the jobcards.
export function summarise(S, from, to) {
  const jcs = S.jobcards.filter(j => j.status !== 'draft' && j.card_date >= from && j.card_date <= to);
  const days = jcs.map(j => {
    const staff = (j.staff || []).reduce((t, s) => t + (Number(s.count) || 1) * (Number(s.hours) || 8) / 8, 0);
    const subs = (j.subbies || []).reduce((t, s) => t + (Number(s.crew) || 1) * (Number(s.hours) || 8) / 8, 0);
    return { j, staff, subs, done: (j.tasks || []).filter(t => t.state), other: (j.extra_tasks || []).filter(x => x.text) };
  });
  const byRole = {}; for (const j of jcs) for (const s of j.staff || []) { const k = s.role || 'Other'; byRole[k] = (byRole[k] || 0) + (Number(s.count) || 1) * (Number(s.hours) || 8) / 8; }
  const bySub = {}; for (const j of jcs) for (const s of j.subbies || []) { bySub[s.name] = bySub[s.name] || { days: 0, work: [] }; bySub[s.name].days += (Number(s.crew) || 1) * (Number(s.hours) || 8) / 8; if (s.work) bySub[s.name].work.push(`${fmtDate(j.card_date)}: ${s.work}`); }
  const plant = {}; for (const j of jcs) for (const p of j.plant || []) if (p.item) plant[p.item] = (plant[p.item] || 0) + (Number(p.hours) || 0);
  const deliveries = jcs.flatMap(j => (j.deliveries || []).map(d => ({ ...d, date: j.card_date })));
  const lost = jcs.reduce((t, j) => t + (Number(j.weather?.lost_hours) || 0), 0), rain = jcs.reduce((t, j) => t + (Number(j.weather?.rain_mm) || 0), 0);
  const issues = jcs.filter(j => j.issues).map(j => ({ date: j.card_date, text: j.issues })), safety = jcs.filter(j => j.safety && !/^none$/i.test(j.safety.trim())).map(j => ({ date: j.card_date, text: j.safety }));
  const visitors = jcs.filter(j => j.visitors).map(j => ({ date: j.card_date, text: j.visitors }));
  const sis = S.sis.filter(s => s.si_date >= from && s.si_date <= to);
  const photos = jcs.flatMap(j => (j.photos || []).map(p => ({ ...p, date: j.card_date })));
  const lookahead = S.tasks.filter(t => t.status !== 'done' && t.start_date && t.start_date <= addDays(to, 14) && (t.end_date || t.start_date) > to);
  return { jcs, days, byRole, bySub, plant, deliveries, lost, rain, issues, safety, visitors, sis, photos, lookahead,
    personDays: days.reduce((t, d) => t + d.staff, 0), subDays: days.reduce((t, d) => t + d.subs, 0), prog: progress(S.tasks) };
}

const PERIODS = [['week', 'This week'], ['last', 'Last week'], ['month', 'This month'], ['all', 'Whole project'], ['custom', 'Custom']];
function periodRange(p, S) {
  const t = today(), ws = weekStart(t);
  if (p === 'last') return [addDays(ws, -7), addDays(ws, -1)];
  if (p === 'month') return [t.slice(0, 8) + '01', t];
  if (p === 'all') return [S.jobcards[0]?.card_date || t, t];
  return [ws, addDays(ws, 6)];
}

async function progressView(el, ctx) {
  const { store, project } = ctx;
  const S = await loadSite(store, project);
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  let per = qs.get('p') || 'week', [from, to] = periodRange(per, S), audience = 'internal', summary = '';
  let F = null;
  const draw = async () => {
    const R = summarise(S, from, to);
    if (audience === 'internal' && !F) { try { F = await Costs.projectFinancials(store, project); } catch (e) { F = null; } }
    el.innerHTML = `<section class="card"><div class="bd row" style="gap:10px;flex-wrap:wrap">
        ${PERIODS.map(([k, l]) => `<button class="btn small ${per === k ? 'primary' : ''}" data-p="${k}">${l}</button>`).join('')}
        <label class="small">From <input type="date" id="rf" value="${from}" style="width:auto"></label><label class="small">to <input type="date" id="rt" value="${to}" style="width:auto"></label>
        <span class="grow"></span><select id="aud" style="width:auto"><option value="internal" ${audience === 'internal' ? 'selected' : ''}>Internal (with costs)</option><option value="client" ${audience === 'client' ? 'selected' : ''}>Client copy (no costs)</option></select>
        <button class="btn primary" id="print">Print / PDF</button></div></section>
      <div class="kpis">
        <div class="kpi"><div class="k">Complete</div><div class="v">${fmt(R.prog * 100)}%</div><div class="small muted">planned ${fmt(planned(S.tasks, to) * 100)}% by ${fmtDate(to)}</div></div>
        <div class="kpi"><div class="k">Days worked</div><div class="v">${R.jcs.length}</div><div class="small muted">${R.jcs.length ? fmtDate(R.jcs[0].card_date) + ' – ' + fmtDate(R.jcs[R.jcs.length - 1].card_date) : 'no submitted jobcards'}</div></div>
        <div class="kpi"><div class="k">Labour</div><div class="v">${fmt(R.personDays + R.subDays, 1)}</div><div class="small muted">person-days · ${fmt(R.subDays, 1)} subcontract</div></div>
        <div class="kpi"><div class="k">Weather</div><div class="v">${fmt(R.lost, 1)} h</div><div class="small muted">lost · ${fmt(R.rain, 0)} mm rain</div></div></div>
      <section class="card"><div class="hd"><h3>Summary</h3><span class="grow"></span><button class="btn small" id="ai">✦ Draft with Claude</button></div>
        <div class="bd"><textarea id="sum" rows="4" placeholder="A few lines on progress, problems and what's next. This goes at the top of the report.">${esc(summary)}</textarea></div></section>
      ${reportBody(S, R, from, to, audience === 'internal' ? F : null, project)}`;
    el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { per = b.dataset.p; if (per !== 'custom') [from, to] = periodRange(per, S); summary = el.querySelector('#sum').value; draw(); });
    el.querySelector('#rf').onchange = e => { from = e.target.value; per = 'custom'; summary = el.querySelector('#sum').value; draw(); };
    el.querySelector('#rt').onchange = e => { to = e.target.value; per = 'custom'; summary = el.querySelector('#sum').value; draw(); };
    el.querySelector('#aud').onchange = e => { audience = e.target.value; summary = el.querySelector('#sum').value; draw(); };
    el.querySelector('#sum').oninput = e => { summary = e.target.value; };
    el.querySelector('#print').onclick = async () => {
      const photoUrls = await photoLinks(store, R.photos.slice(-12));
      open(`${head(audience === 'client' ? 'Progress Report' : 'Progress Report (internal)', `<div style="font-size:13px">${esc(project.name)}${project.client ? ' · ' + esc(project.client) : ''} · ${fmtDate(from)} – ${fmtDate(to)}</div>`)}
        <style>.kp{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:6px 0 10px}.kp div{border:1px solid #ccc;padding:6px 8px}.kp b{display:block;font-size:18px}.ph{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.ph img{width:100%;height:120px;object-fit:cover}h3{font-size:14px;margin:14px 0 4px}</style>
        <div class="kp"><div>Complete<b>${fmt(R.prog * 100)}%</b></div><div>Days worked<b>${R.jcs.length}</b></div><div>Person-days<b>${fmt(R.personDays + R.subDays, 1)}</b></div><div>Hours lost to weather<b>${fmt(R.lost, 1)}</b></div></div>
        ${summary ? `<div class="box"><b>Summary</b><div style="white-space:pre-wrap">${esc(summary)}</div></div>` : ''}
        ${reportBody(S, R, from, to, audience === 'internal' ? F : null, project, true)}
        ${photoUrls.length ? `<h3>Site photos</h3><div class="ph">${photoUrls.map(p => `<figure style="margin:0"><img src="${p.url}" alt=""><figcaption style="font-size:10px">${fmtDate(p.date)}</figcaption></figure>`).join('')}</div>` : ''}
        <p style="font-size:11px;color:#555;margin-top:14px">Compiled from ${R.jcs.length} daily jobcards signed by the Du Green site supervisor.</p>`, 'Progress report ' + project.name);
    };
    el.querySelector('#ai').onclick = async () => {
      const b = el.querySelector('#ai'); b.disabled = true; b.textContent = 'Claude is writing…';
      try {
        const facts = { period: [from, to], complete_pct: Math.round(R.prog * 100), planned_pct: Math.round(planned(S.tasks, to) * 100), days_worked: R.jcs.length, person_days: R.personDays, subcontract_days: R.subDays, weather_hours_lost: R.lost,
          work: R.days.map(d => ({ date: d.j.card_date, tasks: d.done.map(t => `${t.name} ${t.state === 'done' ? 'done' : (t.pct ?? 0) + '%'}`), other: d.other.map(x => x.text) })), issues: R.issues, safety: R.safety, site_instructions: R.sis.map(s => s.description), next: R.lookahead.map(t => t.name), audience };
        const r = await store.claude('ask', { question: `Write a short progress summary (4–6 sentences, plain English, no headings) for a landscaping project ${audience === 'client' ? 'to send to the client – no costs, professional tone' : 'for Du Green management – mention risks and what needs attention'}. Use only these facts: ${JSON.stringify(facts)}`, context: { project: { name: project.name, client: project.client } }, project_id: project.id });
        summary = r.answer || ''; el.querySelector('#sum').value = summary;
      } catch (e) { toast('Claude is not available: ' + e.message); }
      b.disabled = false; b.textContent = '✦ Draft with Claude';
    };
  };
  draw();
}
const planned = (tasks, on) => { let w = 0, p = 0; for (const t of tasks) { w += 1; p += plannedPct(t, on); } return w ? p / w : 0; };

function reportBody(S, R, from, to, F, project, print = false) {
  const tbl = (head, rows) => `<div class="tbl"><table><thead><tr>${head.map(h => `<th${/^[#%]|days|hours|value|E\b/i.test(h) ? ' class="n"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="muted">None</td></tr>`}</tbody></table></div>`;
  const card = (title, inner) => print ? `<h3>${title}</h3>${inner}` : `<section class="card"><div class="hd"><h3>${title}</h3></div>${inner}</section>`;
  const prog = card('Programme', tbl(['Task', 'Area', 'Finish', '% planned', '% done', 'Status'], S.tasks.map(t => `<tr><td>${esc(t.name)}</td><td>${esc(S.areaBy[t.area_id]?.code || '')}</td><td>${fmtDate(t.end_date)}</td><td class="n">${fmt(plannedPct(t, to) * 100)}</td><td class="n">${fmt(t.status === 'done' ? 100 : Number(t.pct) || 0)}</td><td>${isOverdue(t, to) ? '<b style="color:#b3261e">Overdue</b>' : esc(TASK_STATUS[t.status] || t.status || '')}</td></tr>`)));
  const work = card('Work done', tbl(['Date', 'Work', 'People'], R.days.map(d => `<tr><td style="white-space:nowrap">${fmtDate(d.j.card_date)}</td><td>${esc([...d.done.map(t => `${t.name} – ${t.state === 'done' ? 'done' : t.state === 'not_started' ? 'not started' : (t.pct ?? 0) + '%'}`), ...d.other.map(x => x.text + (x.area ? ` (${x.area})` : ''))].join('; '))}</td><td class="n">${fmt(d.staff + d.subs, 1)}</td></tr>`)));
  const labour = card('Labour & subcontractors', `${tbl(['Role', 'Person-days'], Object.entries(R.byRole).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${fmt(v, 1)}</td></tr>`))}
    ${Object.keys(R.bySub).length ? tbl(['Subcontractor', 'Person-days', 'Work reported'], Object.entries(R.bySub).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${fmt(v.days, 1)}</td><td class="small">${esc(v.work.join('; '))}</td></tr>`)) : ''}`);
  const plant = card('Plant & deliveries', `${tbl(['Plant / equipment', 'Hours'], Object.entries(R.plant).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v ? fmt(v, 1) : '–'}</td></tr>`))}
    ${tbl(['Date', 'Delivery'], R.deliveries.map(d => `<tr><td>${fmtDate(d.date)}</td><td>${esc([d.po_number, d.state === 'full' ? 'delivered in full' : d.state === 'part' ? 'part delivery' : '', d.note].filter(Boolean).join(' · '))}</td></tr>`))}`);
  const issues = card('Issues, safety and instructions', `${tbl(['Date', 'Issue / delay'], R.issues.map(i => `<tr><td>${fmtDate(i.date)}</td><td>${esc(i.text)}</td></tr>`))}
    ${R.safety.length ? tbl(['Date', 'Safety incident / near miss'], R.safety.map(i => `<tr><td>${fmtDate(i.date)}</td><td>${esc(i.text)}</td></tr>`)) : ''}
    ${tbl(['SI', 'Instructed by', 'Instruction', 'Status'], R.sis.map(s => `<tr><td>${esc(s.number)}</td><td>${esc(s.instructed_by || '')} <span class="small">${esc(s.instructor_role || '')}</span></td><td>${esc(s.description || '')}</td><td>${esc(s.status)}</td></tr>`))}`);
  const next = card('Next two weeks', tbl(['Task', 'Start', 'Finish'], R.lookahead.map(t => `<tr><td>${esc(t.name)}</td><td>${fmtDate(t.start_date)}</td><td>${fmtDate(t.end_date)}</td></tr>`)));
  const money_ = F ? card('Cost position (internal)', tbl(['', 'E'], [['Contract incl. approved variations', F.revenue], ['Budget cost', F.budget], ['Committed (POs, subcontracts)', F.committed], ['Actual cost to date', F.actual], ['Forecast margin', F.margin], ['Certified by client', F.certified], ['Paid by client', F.paid]].map(([l, v]) => `<tr><td>${l}</td><td class="n">${fmt(v, 2)}</td></tr>`))) : '';
  return prog + work + labour + plant + issues + next + money_;
}

async function photoLinks(store, photos) {
  const out = [];
  for (const p of photos) { try { out.push({ ...p, url: await store.fileUrl('photos', p.path) }); } catch (e) { } }
  return out;
}

// ------------------------------------------------------------------ handover
async function handoverView(el, ctx) {
  const { store, project } = ctx;
  const S = await loadSite(store, project);
  const D = await loadProcurement(store, project);
  let h = S.handover ? JSON.parse(JSON.stringify(S.handover)) : { project_id: project.id, handover_date: today(), practical_completion: today(), defects_days: 90, client_name: project.client || '', client_role: '', snags: [], care_notes: '', notes: '', status: 'draft' };
  const locked = h.status === 'signed';
  const prog = progress(S.tasks);
  const open_ = S.tasks.filter(t => t.status !== 'done');
  const draw = () => {
    const dis = locked ? 'disabled' : '';
    const openSnags = h.snags.filter(s => s.status !== 'closed').length;
    el.innerHTML = `${prog < 0.999 || open_.length ? `<div class="note warn">${open_.length} programme task${open_.length === 1 ? ' is' : 's are'} not marked done (${fmt(prog * 100)}% complete). You can still prepare the handover and list what's outstanding as snags.</div>` : '<div class="note">All programme tasks are complete.</div>'}
      <section class="card"><div class="hd"><h3>Handover details</h3>${locked ? '<span class="pill ok">Signed</span>' : '<span class="pill warn">Draft</span>'}<span class="grow"></span><button class="btn" id="print">Print handover report</button></div>
        <div class="bd grid3"><label class="f">Handover date<input type="date" name="handover_date" value="${esc(h.handover_date || '')}" ${dis}></label><label class="f">Practical completion<input type="date" name="practical_completion" value="${esc(h.practical_completion || '')}" ${dis}></label><label class="f">Defects period (days)<input name="defects_days" inputmode="numeric" value="${h.defects_days ?? 90}" ${dis}></label>
          <label class="f">Client representative<input name="client_name" value="${esc(h.client_name || '')}" ${dis}></label><label class="f">Their role<input name="client_role" value="${esc(h.client_role || '')}" ${dis}></label><label class="f">Signing for Du Green<input name="dg_name" value="${esc(h.dg_name || ctx.me?.full_name || '')}" ${dis}></label></div>
        <div class="bd small muted">Defects period ends <b>${h.practical_completion ? fmtDate(addDays(h.practical_completion, Number(h.defects_days) || 0)) : '–'}</b>. Retention can be released after that.</div></section>
      <section class="card"><div class="hd"><h3>Snag list</h3><span class="small muted">${openSnags} open</span><span class="grow"></span>${locked ? '' : '<button class="btn small" id="adds">+ Snag</button><button class="btn small" id="froms">+ Add unfinished tasks</button>'}</div>
        ${h.snags.length ? `<div class="tbl"><table><thead><tr><th>Item</th><th>Area</th><th>Action needed</th><th>By</th><th>Due</th><th>Status</th></tr></thead><tbody>${h.snags.map((s, i) => `<tr><td><input data-s="${i}" data-k="item" value="${esc(s.item)}"></td><td><select data-s="${i}" data-k="area"><option value="">–</option>${S.areas.map(a => `<option ${s.area === a.code ? 'selected' : ''}>${esc(a.code || '')}</option>`).join('')}</select></td>
          <td><input data-s="${i}" data-k="action" value="${esc(s.action || '')}"></td><td><input style="width:110px" data-s="${i}" data-k="by" value="${esc(s.by || '')}"></td><td><input type="date" data-s="${i}" data-k="due" value="${esc(s.due || '')}" style="width:auto"></td>
          <td><select data-s="${i}" data-k="status"><option value="open" ${s.status !== 'closed' ? 'selected' : ''}>Open</option><option value="closed" ${s.status === 'closed' ? 'selected' : ''}>Closed</option></select></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">No snags recorded.</div>'}</section>
      <section class="card"><div class="hd"><h3>Care & maintenance guide for the client</h3><span class="grow"></span>${locked ? '' : '<button class="btn small" id="ai">✦ Draft with Claude</button>'}</div>
        <div class="bd"><textarea name="care_notes" rows="8" placeholder="Watering, mowing, fertilising, pruning and irrigation care for the first months" ${dis}>${esc(h.care_notes || '')}</textarea></div></section>
      <section class="card"><div class="bd stack"><label class="f">Notes<textarea name="notes" ${dis}>${esc(h.notes || '')}</textarea></label>
        ${h.client_sign ? `<div class="row"><div><div class="small muted">Client</div><img alt="Client signature" src="${h.client_sign}" style="height:70px;background:#fff;border:1px solid var(--line);border-radius:8px"></div>${h.dg_sign ? `<div><div class="small muted">Du Green</div><img alt="Du Green signature" src="${h.dg_sign}" style="height:70px;background:#fff;border:1px solid var(--line);border-radius:8px"></div>` : ''}</div>` : ''}
        <div class="row"><span class="grow"></span>${locked ? (['admin', 'qs'].includes(ctx.me?.role) ? '<button class="btn" id="reopen">Reopen</button>' : '') : '<button class="btn" id="save">Save</button><button class="btn primary" id="sign">Client signs handover</button>'}</div></div></section>`;
    wire();
  };
  const read = () => {
    if (locked) { el.querySelectorAll('[data-s]').forEach(i => { h.snags[+i.dataset.s][i.dataset.k] = i.value; }); return; }
    const f = formData(el); for (const k of ['handover_date', 'practical_completion', 'client_name', 'client_role', 'dg_name', 'care_notes', 'notes']) h[k] = f[k] ?? h[k]; h.defects_days = num(f.defects_days) ?? 90;
    el.querySelectorAll('[data-s]').forEach(i => { h.snags[+i.dataset.s][i.dataset.k] = i.value; });
  };
  const save = async (extra = {}) => { read(); Object.assign(h, extra); const row = { ...h }; delete row.id; delete row.created_at; delete row.created_by; h = h.id ? { ...h, ...(await store.update('handovers', h.id, row)) } : await store.insert('handovers', row); return h; };
  const wire = () => {
    const q = s => el.querySelector(s);
    q('#print').onclick = async () => { read(); await openHandoverDoc(store, project, h, S, D); };
    q('#adds') && (q('#adds').onclick = () => { read(); h.snags.push({ id: uid(), item: '', area: '', action: '', by: 'Du Green', due: addDays(today(), 7), status: 'open' }); draw(); });
    q('#froms') && (q('#froms').onclick = () => { read(); for (const t of open_) if (!h.snags.some(s => s.task_id === t.id)) h.snags.push({ id: uid(), task_id: t.id, item: t.name, area: S.areaBy[t.area_id]?.code || '', action: `Complete (${fmt(Number(t.pct) || 0)}% done)`, by: 'Du Green', due: addDays(today(), 7), status: 'open' }); draw(); });
    q('#save') && (q('#save').onclick = async () => { await save(); toast('Handover saved'); });
    el.querySelectorAll('[data-s]').forEach(i => i.onchange = async () => { if (locked) { read(); await store.update('handovers', h.id, { snags: h.snags }); toast('Snag updated'); } });
    q('#reopen') && (q('#reopen').onclick = async () => { await store.update('handovers', h.id, { status: 'draft' }); ctx.reload(); });
    q('#ai') && (q('#ai').onclick = async () => {
      read(); const b = q('#ai'); b.disabled = true; b.textContent = 'Claude is writing…';
      try {
        const plants = D.items.filter(i => ['Plants', 'Trees', 'Lawn & grassing', 'Irrigation & piping'].includes(i.category)).map(i => `${i.description}${i.spec ? ' (' + i.spec + ')' : ''}: ${fmt(i.qty)} ${i.unit}`);
        const r = await store.claude('ask', { question: `Write a practical care and maintenance guide for the client after handover of a new landscape in Eswatini. Cover the first 3 months then ongoing: watering, lawn, plants and trees, mulch, fertilising, pruning, irrigation checks, and when to call Du Green. Plain text with short headed sections, no prices. Installed items: ${plants.join('; ') || 'general garden installation'}.`, context: { project: { name: project.name, site: project.site_address } }, project_id: project.id });
        h.care_notes = r.answer || h.care_notes; draw();
      } catch (e) { toast('Claude is not available: ' + e.message); }
    });
    q('#sign') && (q('#sign').onclick = async () => {
      read();
      if (!h.client_name.trim()) return toast('Enter the client representative’s name');
      const open = h.snags.filter(s => s.status !== 'closed').length;
      if (open && !(await confirmDlg('Hand over with open snags?', `${open} snag${open === 1 ? '' : 's'} will be listed on the handover for Du Green to close out.`, 'Continue'))) return;
      const cs = await captureSignature('Client accepts the handover', `${h.client_name}${h.client_role ? ' – ' + h.client_role : ''}`); if (!cs) return;
      const ds = await captureSignature('Signature for Du Green', h.dg_name || ''); if (!ds) return;
      await save({ client_sign: cs, dg_sign: ds, signed_at: new Date().toISOString(), status: 'signed' });
      await store.update('projects', project.id, { status: 'handover' });
      toast('Handover signed. Project moved to Handover.'); ctx.reload();
    });
  };
  draw();
}

async function openHandoverDoc(store, project, h, S, D) {
  const jcs = S.jobcards.filter(j => j.status !== 'draft');
  const R = summarise(S, jcs[0]?.card_date || today(), today());
  const photos = await photoLinks(store, R.photos.slice(-8));
  const byArea = groupBy(D.items.flatMap(i => i.lines.map(l => ({ ...l, item: i }))), l => l.area ? `${l.area.code || ''} ${l.area.name || ''}`.trim() : 'Site-wide');
  open(`${head('Practical Completion & Handover', `<div style="font-size:13px">${esc(project.name)}${project.client ? ' · ' + esc(project.client) : ''}</div>`)}
    <style>h3{font-size:14px;margin:14px 0 4px}.ph{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.ph img{width:100%;height:120px;object-fit:cover}</style>
    <div class="meta"><div><b>Handover date:</b> ${fmtDate(h.handover_date)}<br><b>Practical completion:</b> ${fmtDate(h.practical_completion)}<br><b>Defects period:</b> ${h.defects_days} days, ends ${fmtDate(addDays(h.practical_completion || today(), Number(h.defects_days) || 0))}</div>
      <div><b>Site:</b> ${esc(project.site_address || '')}<br><b>Works period:</b> ${jcs.length ? fmtDate(jcs[0].card_date) + ' – ' + fmtDate(jcs[jcs.length - 1].card_date) : '–'}<br><b>Days on site:</b> ${jcs.length} · ${fmt(R.personDays + R.subDays, 0)} person-days</div></div>
    <h3>Areas handed over</h3>
    <table><thead><tr><th>Area</th><th>Type</th><th class="n">Size</th></tr></thead><tbody>${S.areas.map(a => { const m = areaMeasures(a); return `<tr><td>${esc((a.code || '') + ' ' + (a.name || ''))}</td><td>${esc(a.type || '')}</td><td class="n">${m.area ? fmt(m.area, 1) + ' m²' : m.length ? fmt(m.length, 1) + ' m' : m.count ? fmt(m.count) + ' no.' : ''}</td></tr>`; }).join('')}</tbody></table>
    <h3>Works installed</h3>
    <table><thead><tr><th>Item</th><th>Specification</th><th class="n">Qty</th><th>Unit</th></tr></thead><tbody>${Object.entries(byArea).map(([g, ls]) => `<tr class="sec"><td colspan="4">${esc(g)}</td></tr>` + ls.filter(l => l.item.category !== 'Transport').map(l => `<tr><td>${esc(l.item.description)}</td><td>${esc(l.item.spec || '')}</td><td class="n">${fmt(l.qty_calc, 2)}</td><td>${esc(l.item.unit || '')}</td></tr>`).join('')).join('')}</tbody></table>
    ${S.sis.filter(s => ['approved', 'done'].includes(s.status)).length ? `<h3>Variations carried out</h3><table><tbody>${S.sis.filter(s => ['approved', 'done'].includes(s.status)).map(s => `<tr><td>${esc(s.number)}</td><td>${esc(s.description || '')}</td><td>${esc(s.instructed_by || '')}</td></tr>`).join('')}</tbody></table>` : ''}
    <h3>Snag list</h3>
    <table><thead><tr><th>#</th><th>Item</th><th>Area</th><th>Action</th><th>By</th><th>Due</th><th>Status</th></tr></thead><tbody>${h.snags.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.item)}</td><td>${esc(s.area || '')}</td><td>${esc(s.action || '')}</td><td>${esc(s.by || '')}</td><td>${s.due ? fmtDate(s.due) : ''}</td><td>${s.status === 'closed' ? 'Closed' : 'Open'}</td></tr>`).join('') || '<tr><td colspan="7">No snags.</td></tr>'}</tbody></table>
    ${h.care_notes ? `<h3>Care & maintenance guide</h3><div class="box" style="white-space:pre-wrap">${esc(h.care_notes)}</div>` : ''}
    ${h.notes ? `<div class="box"><b>Notes</b><div style="white-space:pre-wrap">${esc(h.notes)}</div></div>` : ''}
    ${photos.length ? `<h3>Photos</h3><div class="ph">${photos.map(p => `<img src="${p.url}" alt="">`).join('')}</div>` : ''}
    <p style="font-size:12px;margin-top:14px">The client accepts the works listed above as practically complete, subject to the snags listed, which Du Green will attend to. Defects that appear during the defects period will be made good by Du Green.</p>
    <div class="sig"><div>${h.client_sign ? `<img src="${h.client_sign}" style="height:60px">` : ''}${esc(h.client_name || 'Client')}${h.client_role ? ' – ' + esc(h.client_role) : ''}${h.signed_at ? `<br><small>Signed ${new Date(h.signed_at).toLocaleString('en-GB')}</small>` : ''}</div>
      <div>${h.dg_sign ? `<img src="${h.dg_sign}" style="height:60px">` : ''}${esc(h.dg_name || '')} – Du Green</div></div>`, 'Handover ' + project.name);
}
