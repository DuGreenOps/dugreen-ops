// Site diary: daily jobcards (auto-filled from the programme), site instructions (signed on screen) and supervisor requests.
import { esc, fmt, money, dialog, formData, toast, confirmDlg, num, today, fmtDate, addDays, uid, typeColor, groupBy } from './util.js';
import { sortAreas } from './areas.js';
import { activeOn, taskPill, isOverdue } from './pow.js';
import { captureSignature } from './sign.js';
import { openJobcardDoc, openSiDoc } from './docs.js';
import { poAct } from './procure.js';
import { contractFor, contractBadge, startContract } from './contracts.js';
import { editStaff } from './staff.js';

export const WEATHER = ['Sunny', 'Partly cloudy', 'Overcast', 'Light rain', 'Heavy rain', 'Storm', 'Windy', 'Very hot', 'Cold / frost'];
export const PLANT_QUICK = ['TLB', 'Tipper truck', 'Bakkie (LDV)', 'Brush cutter', 'Lawn mower', 'Water cart', 'Plate compactor', 'Rotavator', 'Chainsaw'];
export const REQ_KINDS = ['Materials', 'Plant / equipment', 'Labour', 'Transport', 'Information / decision', 'Other'];
export const SI_ROLES = ['Client', "Client's representative", 'Architect / landscape architect', 'Engineer', 'Main contractor', 'Project manager', 'Du Green management', 'Other'];
export const SI_STATUS = { open: 'Open', signed: 'Signed', priced: 'Priced', approved: 'Approved (variation)', rejected: 'Rejected', done: 'Completed' };
export const REQ_STATUS = { pending: 'Pending', approved: 'Approved', declined: 'Declined', done: 'Done' };
export const JC_STATUS = { draft: 'Draft', submitted: 'Submitted', approved: 'Approved' };
const pill = (s, map, cls) => `<span class="pill ${cls[s] || 'mute'}">${esc(map[s] || s)}</span>`;
export const jcPill = s => pill(s, JC_STATUS, { draft: 'warn', submitted: 'info', approved: 'ok' });
export const siPill = s => pill(s, SI_STATUS, { open: 'warn', signed: 'info', priced: 'info', approved: 'ok', rejected: 'bad', done: 'mute' });
export const reqPill = s => pill(s, REQ_STATUS, { pending: 'warn', approved: 'ok', declined: 'bad', done: 'mute' });

export async function render(root, ctx) {
  const { store, project } = ctx;
  const [sub = 'jobcards', arg] = (ctx.rest || []);
  const [areasRaw, staff, tasks, jobcards, sis, reqs, pos, suppliers, contracts] = await Promise.all([
    store.list('areas', { project_id: project.id }), store.list('staff', {}, 'name'), store.list('tasks', { project_id: project.id }, 'sort'),
    store.list('jobcards', { project_id: project.id }, 'card_date'), store.list('site_instructions', { project_id: project.id }), store.list('requests', { project_id: project.id }),
    store.list('purchase_orders', { project_id: project.id }), store.list('suppliers', {}, 'name'), store.list('contracts', {}, null)]);
  const openIds = pos.filter(p => ['approved', 'issued', 'part'].includes(p.status)).map(p => p.id);
  const poLines = openIds.length ? await store.list('po_lines', { po_id: openIds }, 'sort') : [];
  const areas = sortAreas(areasRaw);
  const D = { areas, areaBy: Object.fromEntries(areas.map(a => [a.id, a])), staff, staffBy: Object.fromEntries(staff.map(s => [s.id, s])), tasks, jobcards, sis, reqs, pos, poLines, contracts, sup: Object.fromEntries(suppliers.map(s => [s.id, s])) };
  const openSI = sis.filter(s => ['open', 'signed', 'priced'].includes(s.status)).length, pendReq = reqs.filter(r => r.status === 'pending').length;
  root.innerHTML = `<div class="page">
    <div class="row"><div class="grow"><div class="eyebrow">Site Supervisor</div><h2 style="font-size:24px">Site diary</h2></div>
      <nav class="subtabs"><a href="#/p/${project.id}/site" class="${sub === 'jobcards' || sub === 'jobcard' ? 'on' : ''}">Daily jobcards</a>
        <a href="#/p/${project.id}/site/si" class="${sub === 'si' ? 'on' : ''}">Site instructions${openSI ? ` (${openSI})` : ''}</a>
        <a href="#/p/${project.id}/site/requests" class="${sub === 'requests' ? 'on' : ''}">Requests${pendReq ? ` (${pendReq})` : ''}</a></nav></div>
    <div id="sv"></div></div>`;
  const el = root.querySelector('#sv');
  if (sub === 'jobcard') return jobcardView(el, ctx, D, arg || today());
  if (sub === 'si') return siList(el, ctx, D);
  if (sub === 'requests') return reqList(el, ctx, D);
  return jobcardList(el, ctx, D);
}

// ----------------------------------------------------------- jobcards
function jobcardList(el, ctx, D) {
  const { project } = ctx;
  const cards = [...D.jobcards].sort((a, b) => b.card_date.localeCompare(a.card_date));
  const todays = cards.filter(c => c.card_date === today());
  el.innerHTML = `<section class="card"><div class="hd"><h3>Daily jobcards</h3><span class="grow"></span>
      <a class="btn" href="#/p/${project.id}/pow/plan?p=today">Today's plan</a>
      <button class="btn" id="blank">Print blank jobcard</button>
      <a class="btn primary" href="#/p/${project.id}/site/jobcard/${today()}">${todays.length ? "Open today's jobcard" : "Start today's jobcard"}</a></div>
    ${cards.length ? `<div class="tbl"><table><thead><tr><th>Date</th><th>Supervisor</th><th class="n">Staff</th><th class="n">Tasks</th><th>Issues</th><th>Status</th></tr></thead><tbody>
      ${cards.map(c => { const st = (c.staff || []).reduce((t, s) => t + (Number(s.count) || 1), 0) + (c.subbies || []).reduce((t, s) => t + (Number(s.crew) || 1), 0); const tk = c.tasks || []; return `<tr class="click" data-d="${c.card_date}" data-s="${c.supervisor_id || ''}"><td><b>${fmtDate(c.card_date)}</b></td><td>${esc(D.staffBy[c.supervisor_id]?.name || '–')}</td><td class="n">${st}</td>
        <td class="n">${tk.filter(t => t.state === 'done').length}/${tk.length}${(c.extra_tasks || []).length ? ` +${c.extra_tasks.length}` : ''}</td><td class="small">${c.issues ? '⚠ ' + esc(c.issues.slice(0, 60)) : '–'}</td><td>${jcPill(c.status)}</td></tr>`; }).join('')}
    </tbody></table></div>` : `<div class="empty"><b>No jobcards yet</b>Each day the supervisor opens today's jobcard. It's filled in from the programme, and they record staff, weather, work done, deliveries and issues.</div>`}</section>`;
  el.querySelectorAll('[data-d]').forEach(r => r.onclick = () => ctx.go(`#/p/${project.id}/site/jobcard/${r.dataset.d}${r.dataset.s ? '?s=' + r.dataset.s : ''}`));
  el.querySelector('#blank').onclick = () => {
    const d = today(); const planned = D.tasks.filter(t => activeOn(t, d));
    openJobcardDoc(project, { card_date: d, tasks: planned.map(t => ({ task_id: t.id, name: t.name, area: D.areaBy[t.area_id]?.code })), blank: true }, D);
  };
}

async function jobcardView(el, ctx, D, date) {
  const { store, project } = ctx;
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const meStaff = D.staff.find(s => s.user_email && s.user_email === (ctx.me?.email || '').toLowerCase());
  let supId = qs.get('s') || meStaff?.id || '';
  let card = D.jobcards.find(c => c.card_date === date && (c.supervisor_id || '') === supId) || (!qs.get('s') && D.jobcards.find(c => c.card_date === date));
  if (card) supId = card.supervisor_id || '';
  const planned = D.tasks.filter(t => activeOn(t, date) && (!supId || !t.supervisor_id || t.supervisor_id === supId));
  // Working copy: existing card or a new one filled from the programme.
  const jc = card ? JSON.parse(JSON.stringify(card)) : {
    project_id: project.id, card_date: date, supervisor_id: supId || null, status: 'draft',
    weather: { am: '', pm: '', rain_mm: null, temp: null, lost_hours: null },
    staff: [], tasks: planned.map(t => ({ task_id: t.id, name: t.name, area: D.areaBy[t.area_id]?.code || '', state: '', pct: Number(t.pct) || 0, notes: '' })),
    extra_tasks: [{ text: '', area: '', notes: '' }, { text: '', area: '', notes: '' }], plant: [], deliveries: [], subbies: [], issues: '', safety: '', visitors: '', notes: '', photos: [],
  };
  // Add newly planned tasks that weren't on a saved draft.
  if (card && jc.status === 'draft') for (const t of planned) if (!jc.tasks.some(x => x.task_id === t.id)) jc.tasks.push({ task_id: t.id, name: t.name, area: D.areaBy[t.area_id]?.code || '', state: '', pct: Number(t.pct) || 0, notes: '' });
  const locked = jc.status !== 'draft';
  const openPOs = D.pos.filter(p => ['approved', 'issued', 'part'].includes(p.status) || (jc.deliveries || []).some(d => d.po_id === p.id));
  jc.subbies = jc.subbies || [];
  const canApprove = ['admin', 'qs'].includes(ctx.me?.role);
  const active = D.staff.filter(s => s.active !== false && s.kind !== 'subcontractor');
  const subs = D.staff.filter(s => s.active !== false && s.kind === 'subcontractor');
  const cOf = id => contractFor(id, D.contracts, project.id, date);
  const signBtn = (id, r) => r.ok || locked ? '' : `<button class="btn small" style="display:block;margin-top:4px" type="button" data-sign="${id}">${r.state === 'draft' ? 'Finish contract' : 'Sign contract'}</button>`;
  const sel = (name, opts, v, dis) => `<select name="${name}" ${dis ? 'disabled' : ''}><option value="">—</option>${opts.map(o => `<option ${v === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  const dis = locked ? 'disabled' : '';
  const photoUrls = {};
  for (const p of jc.photos || []) { try { photoUrls[p.path] = await store.fileUrl('photos', p.path); } catch (e) { } }

  const html = () => `
    <section class="card"><div class="hd"><div class="grow"><div class="small muted"><a href="#/p/${project.id}/site">Jobcards</a> /</div><h3>Daily jobcard · ${new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}</h3></div>
      ${jcPill(jc.status)}<button class="btn" id="prev">‹ Day</button><button class="btn" id="next">Day ›</button><button class="btn" id="print">Print</button></div>
      <div class="bd grid2"><label class="f">Supervisor<select id="sup" ${dis}><option value="">—</option>${active.map(s => `<option value="${s.id}" ${jc.supervisor_id === s.id ? 'selected' : ''}>${esc(s.name)} · ${esc(s.role || '')}</option>`).join('')}</select></label>
        <div class="small muted" style="align-self:end">${planned.length} task${planned.length === 1 ? '' : 's'} planned for this day${supId ? ' for this supervisor' : ''}.</div></div></section>

    <section class="card"><div class="hd"><h3>☀ Weather</h3></div><div class="bd grid3">
      <label class="f">Morning${sel('w_am', WEATHER, jc.weather?.am, locked)}</label><label class="f">Afternoon${sel('w_pm', WEATHER, jc.weather?.pm, locked)}</label>
      <label class="f">Rain (mm)<input name="w_rain" inputmode="decimal" value="${jc.weather?.rain_mm ?? ''}" ${dis}></label>
      <label class="f">Temperature (°C)<input name="w_temp" inputmode="decimal" value="${jc.weather?.temp ?? ''}" ${dis}></label>
      <label class="f span2">Hours lost to weather<input name="w_lost" inputmode="decimal" value="${jc.weather?.lost_hours ?? ''}" ${dis}></label></div></section>

    <section class="card"><div class="hd"><h3>👷 Staff on site</h3><span class="small muted">${(jc.staff || []).reduce((t, s) => t + (Number(s.count) || 1), 0)} people</span><span class="grow"></span>${locked ? '' : '<button class="btn small" id="addp">+ Add person to register</button>'}</div>
      <div class="tbl"><table><thead><tr><th></th><th>Name</th><th>Role</th><th>Contract</th><th class="n">Hours</th></tr></thead><tbody>
      ${active.map(s => { const on = (jc.staff || []).find(x => x.staff_id === s.id); const r = cOf(s.id); return `<tr><td><input type="checkbox" data-st="${s.id}" ${on ? 'checked' : ''} ${dis} aria-label="${esc(s.name)} on site"></td><td>${esc(s.name)}</td><td class="small">${esc(s.role || '')}</td><td style="white-space:normal">${contractBadge(r, true)}${signBtn(s.id, r)}</td>
        <td class="n"><input class="num" style="width:70px" data-sh="${s.id}" inputmode="decimal" value="${on?.hours ?? 8}" ${dis}></td></tr>`; }).join('')}
      ${(jc.staff || []).filter(x => !x.staff_id).map((x, i) => `<tr><td>✓</td><td><input data-ox="${i}" data-k="name" value="${esc(x.name)}" ${dis} placeholder="Name"></td><td><input data-ox="${i}" data-k="role" value="${esc(x.role || '')}" ${dis} placeholder="Role"></td><td><span class="pill bad">Not in register</span></td>
        <td class="n">${x.count > 1 || x.casual ? `<input class="num" style="width:56px" data-ox="${i}" data-k="count" value="${x.count || 1}" ${dis} aria-label="Number"> × ` : ''}<input class="num" style="width:70px" data-ox="${i}" data-k="hours" value="${x.hours ?? 8}" ${dis} aria-label="Hours"></td></tr>`).join('')}
      </tbody></table></div>${active.length ? '' : '<div class="small muted" style="padding:10px 14px">Add your team with “+ Add person to register” so they can be ticked here and sign contracts.</div>'}</section>

    <section class="card"><div class="hd"><h3>🤝 Subcontractors on site</h3><span class="small muted">${jc.subbies.reduce((t, s) => t + (Number(s.crew) || 1), 0)} people</span><span class="grow"></span>${locked ? '' : '<button class="btn small" id="adds">+ Add subcontractor</button>'}</div>
      ${subs.length ? `<div class="tbl"><table><thead><tr><th></th><th>Subcontractor</th><th>Contract</th><th class="n">Crew</th><th class="n">Hours</th><th>Work done today</th></tr></thead><tbody>
      ${subs.map(s => { const on = jc.subbies.find(x => x.person_id === s.id); const r = cOf(s.id); return `<tr><td><input type="checkbox" data-sb="${s.id}" ${on ? 'checked' : ''} ${dis} aria-label="${esc(s.name)} on site"></td><td><b>${esc(s.name)}</b><div class="small muted">${esc(s.role || '')}</div></td><td style="white-space:normal">${contractBadge(r, true)}${signBtn(s.id, r)}</td>
        <td class="n"><input class="num" style="width:56px" data-sbc="${s.id}" inputmode="numeric" value="${on?.crew ?? s.crew_size ?? 1}" ${dis}></td><td class="n"><input class="num" style="width:60px" data-sbh="${s.id}" inputmode="decimal" value="${on?.hours ?? 8}" ${dis}></td>
        <td><input data-sbw="${s.id}" value="${esc(on?.work || '')}" placeholder="e.g. Laid 40 m² paving in H1" ${dis}></td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="empty small">No subcontractors in the register yet.</div>'}</section>

    <section class="card"><div class="hd"><h3>✔ Planned work</h3><span class="small muted">From the programme</span></div>
      ${jc.tasks.length ? `<div class="tbl"><table><thead><tr><th>Task</th><th>Done?</th><th class="n">% complete</th><th>Notes</th></tr></thead><tbody>
      ${jc.tasks.map((t, i) => `<tr><td>${t.area ? `<span class="code" style="background:${typeColor(D.areas.find(a => a.code === t.area)?.type)};font-size:11px;padding:2px 5px">${esc(t.area)}</span> ` : ''}<b>${esc(t.name)}</b></td>
        <td><select data-tk="${i}" data-k="state" ${dis}><option value="">—</option><option value="done" ${t.state === 'done' ? 'selected' : ''}>Done</option><option value="partial" ${t.state === 'partial' ? 'selected' : ''}>Partly done</option><option value="not_started" ${t.state === 'not_started' ? 'selected' : ''}>Not started</option></select></td>
        <td class="n"><input class="num" style="width:70px" data-tk="${i}" data-k="pct" inputmode="decimal" value="${t.pct ?? ''}" ${dis}></td><td><input data-tk="${i}" data-k="notes" value="${esc(t.notes || '')}" ${dis}></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty small">Nothing planned on the programme for this day.</div>'}</section>

    <section class="card"><div class="hd"><h3>✚ Other work done</h3><span class="small muted">Not on the plan</span><span class="grow"></span>${locked ? '' : '<button class="btn small" id="addx">+ Line</button>'}</div><div class="bd stack" style="gap:6px">
      ${(jc.extra_tasks || []).map((x, i) => `<div class="grid3"><input class="span2" data-xt="${i}" data-k="text" value="${esc(x.text)}" placeholder="Work done" ${dis}><select data-xt="${i}" data-k="area" ${dis}><option value="">Area</option>${D.areas.map(a => `<option ${x.area === a.code ? 'selected' : ''}>${esc(a.code || '')}</option>`).join('')}</select></div>`).join('')}</div></section>

    <section class="card"><div class="hd"><h3>🚜 Plant & equipment</h3><span class="grow"></span>${locked ? '' : `<select id="pq" style="width:auto"><option value="">+ Add…</option>${PLANT_QUICK.map(p => `<option>${p}</option>`).join('')}<option value="__other">Other</option></select>`}</div>
      ${(jc.plant || []).length ? `<div class="tbl"><table><thead><tr><th>Item</th><th class="n">Hours</th><th>Notes (hired from, breakdowns…)</th></tr></thead><tbody>${jc.plant.map((p, i) => `<tr><td><input data-pl="${i}" data-k="item" value="${esc(p.item)}" ${dis}></td><td class="n"><input class="num" style="width:70px" data-pl="${i}" data-k="hours" value="${p.hours ?? ''}" ${dis}></td><td><input data-pl="${i}" data-k="notes" value="${esc(p.notes || '')}" ${dis}></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">No plant recorded.</div>'}</section>

    <section class="card"><div class="hd"><h3>📦 Deliveries received</h3></div><div class="bd stack" style="gap:8px">
      ${openPOs.length ? openPOs.map(p => { const d = (jc.deliveries || []).find(x => x.po_id === p.id) || {}; return `<div class="row"><select data-dv="${p.id}" style="width:auto" ${dis}><option value="">Not today</option><option value="full" ${d.state === 'full' ? 'selected' : ''}>Delivered in full</option><option value="part" ${d.state === 'part' ? 'selected' : ''}>Part delivery</option></select>
        <span class="grow"><b>${esc(p.number)}</b> · ${esc(D.sup[p.supplier_id]?.name || '')}${p.status === 'part' ? ' <span class="pill warn">Part delivered before</span>' : ''}</span><input data-dvn="${p.id}" placeholder="Delivery note no. / what's missing" value="${esc(d.note || '')}" style="max-width:280px" ${dis}></div>
        <div data-dvl="${p.id}" class="tbl" ${d.state === 'part' ? '' : 'hidden'}><table><thead><tr><th>Item</th><th class="n">Ordered</th><th class="n">Received before</th><th class="n">Received today</th></tr></thead><tbody>
          ${D.poLines.filter(l => l.po_id === p.id).map(l => `<tr><td>${esc(l.description)}<div class="small muted">${esc(l.spec || '')}</div></td><td class="n">${fmt(l.qty, 2)} ${esc(l.unit || '')}</td><td class="n">${fmt(Number(l.qty_received) || 0, 2)}</td>
            <td class="n"><input class="num" style="width:80px" data-dq="${l.id}" inputmode="decimal" value="${(d.lines || []).find(x => x.po_line_id === l.id)?.qty ?? ''}" ${dis}></td></tr>`).join('')}</tbody></table></div>`; }).join('') : '<span class="small muted">No purchase orders are awaiting delivery.</span>'}
      <label class="f">Other deliveries<input name="other_deliv" value="${esc((jc.deliveries || []).find(x => !x.po_id)?.note || '')}" ${dis}></label></div></section>

    <section class="card"><div class="hd"><h3>⚠ Issues, safety and visitors</h3></div><div class="bd stack">
      <label class="f">Issues / delays<textarea name="issues" ${dis}>${esc(jc.issues || '')}</textarea></label>
      <label class="f">Safety incidents / near misses<textarea name="safety" ${dis} placeholder="None">${esc(jc.safety || '')}</textarea></label>
      <label class="f">Visitors / instructions received<textarea name="visitors" ${dis}>${esc(jc.visitors || '')}</textarea></label>
      <label class="f">Notes for tomorrow<textarea name="notes" ${dis}>${esc(jc.notes || '')}</textarea></label>
      <div class="row"><a class="btn small" href="#/p/${project.id}/site/si">Record a site instruction</a><button class="btn small" id="req" type="button">Request materials / plant / labour</button></div></div></section>

    <section class="card"><div class="hd"><h3>📷 Photos</h3><span class="grow"></span>${locked ? '' : '<label class="btn small">Add photo<input type="file" accept="image/*" capture="environment" id="ph" hidden multiple></label>'}</div>
      <div class="bd row">${(jc.photos || []).map(p => `<img alt="Site photo" style="width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid var(--line)" src="${photoUrls[p.path] || ''}">`).join('') || '<span class="small muted">No photos.</span>'}</div></section>

    <section class="card"><div class="hd"><h3>Sign-off</h3></div><div class="bd stack">
      ${jc.supervisor_sign ? `<div><div class="small muted">Supervisor signature</div><img alt="Supervisor signature" src="${jc.supervisor_sign}" style="height:80px;background:#fff;border:1px solid var(--line);border-radius:8px"></div>` : ''}
      <div class="row"><span class="grow small muted">${jc.status === 'draft' ? 'Save as you go. Submit at the end of the day: progress updates the programme, and deliveries update the purchase orders.' : jc.status === 'submitted' ? 'Submitted. Waiting for review.' : `Approved ${jc.reviewed_at ? fmtDate(jc.reviewed_at) : ''}.`}</span>
        ${jc.status === 'draft' ? '<button class="btn" id="save">Save draft</button><button class="btn primary" id="submit">Sign & submit</button>' : ''}
        ${jc.status === 'submitted' && canApprove ? '<button class="btn" id="reopen">Send back</button><button class="btn primary" id="approve">Approve jobcard</button>' : ''}
        ${jc.status !== 'draft' && canApprove ? '' : ''}</div></div></section>`;

  const read = () => {
    const q = s => el.querySelector(s);
    if (locked) return;
    jc.supervisor_id = q('#sup').value || null;
    jc.weather = { am: q('[name=w_am]').value, pm: q('[name=w_pm]').value, rain_mm: num(q('[name=w_rain]').value), temp: num(q('[name=w_temp]').value), lost_hours: num(q('[name=w_lost]').value) };
    const others = (jc.staff || []).filter(x => !x.staff_id);
    el.querySelectorAll('[data-ox]').forEach(i => { const o = others[+i.dataset.ox]; o[i.dataset.k] = ['count', 'hours'].includes(i.dataset.k) ? num(i.value) : i.value; });
    jc.staff = [...active.filter(s => q(`[data-st="${s.id}"]`)?.checked).map(s => ({ staff_id: s.id, name: s.name, role: s.role, kind: s.kind || 'staff', hours: num(q(`[data-sh="${s.id}"]`).value) ?? 8, count: 1, day_rate: s.day_rate ?? null, contract_id: cOf(s.id).ok ? cOf(s.id).c.id : null })), ...others];
    jc.subbies = subs.filter(s => q(`[data-sb="${s.id}"]`)?.checked).map(s => ({ person_id: s.id, name: s.name, trade: s.role, crew: num(q(`[data-sbc="${s.id}"]`).value) || 1, hours: num(q(`[data-sbh="${s.id}"]`).value) ?? 8, work: q(`[data-sbw="${s.id}"]`).value, contract_id: cOf(s.id).ok ? cOf(s.id).c.id : null }));
    el.querySelectorAll('[data-tk]').forEach(i => { const t = jc.tasks[+i.dataset.tk]; t[i.dataset.k] = i.dataset.k === 'pct' ? num(i.value) : i.value; if (i.dataset.k === 'state' && i.value === 'done') t.pct = 100; });
    el.querySelectorAll('[data-xt]').forEach(i => { const x = jc.extra_tasks[+i.dataset.xt]; if (x) x[i.dataset.k] = i.value; });
    el.querySelectorAll('[data-pl]').forEach(i => { jc.plant[+i.dataset.pl][i.dataset.k] = i.dataset.k === 'hours' ? num(i.value) : i.value; });
    const dv = []; el.querySelectorAll('[data-dv]').forEach(s => { if (s.value) { const p = D.pos.find(x => x.id === s.dataset.dv); const lines = s.value === 'part' ? [...el.querySelectorAll(`[data-dvl="${p.id}"] [data-dq]`)].map(i => ({ po_line_id: i.dataset.dq, qty: num(i.value) })).filter(x => x.qty) : []; dv.push({ po_id: p.id, po_number: p.number, state: s.value, note: q(`[data-dvn="${p.id}"]`).value, lines }); } });
    const od = q('[name=other_deliv]').value; if (od) dv.push({ po_id: null, note: od });
    jc.deliveries = dv;
    for (const k of ['issues', 'safety', 'visitors', 'notes']) jc[k] = q(`[name=${k}]`).value;
  };
  const save = async (extra = {}) => {
    read();
    const row = { ...jc, ...extra, extra_tasks: (jc.extra_tasks || []).filter(x => x.text || x.area), project_id: project.id, card_date: date };
    delete row.id; delete row.created_at; delete row.created_by; delete row.updated_at;
    card = card ? await store.update('jobcards', card.id, row) : await store.insert('jobcards', row);
    const working = jc.extra_tasks; // keep the blank lines on screen; only filled ones are stored
    Object.assign(jc, card, { extra_tasks: working });
    return card;
  };
  const draw = () => { el.innerHTML = html(); wire(); };
  const wire = () => {
    const q = s => el.querySelector(s);
    q('#prev').onclick = () => ctx.go(`#/p/${project.id}/site/jobcard/${addDays(date, -1)}${jc.supervisor_id ? '?s=' + jc.supervisor_id : ''}`);
    q('#next').onclick = () => ctx.go(`#/p/${project.id}/site/jobcard/${addDays(date, 1)}${jc.supervisor_id ? '?s=' + jc.supervisor_id : ''}`);
    q('#print').onclick = () => { read(); openJobcardDoc(project, jc, D); };
    if (!locked) {
      q('#sup').onchange = () => { read(); };
      const addPerson = async kind => { read(); const p = await editStaff(store, null, { me: ctx.me, kind }); if (!p || p === 'deleted') return; D.staff.push(p); D.staffBy[p.id] = p; if (kind === 'subcontractor') { subs.push(p); jc.subbies.push({ person_id: p.id, name: p.name, crew: p.crew_size || 1, hours: 8, work: '' }); } else { active.push(p); jc.staff.push({ staff_id: p.id, name: p.name, role: p.role, kind: p.kind, hours: 8, count: 1 }); } draw(); };
      q('#addp').onclick = () => addPerson('casual');
      q('#adds') && (q('#adds').onclick = () => addPerson('subcontractor'));
      el.querySelectorAll('[data-dv]').forEach(s => s.onchange = () => { const box = el.querySelector(`[data-dvl="${s.dataset.dv}"]`); if (box) box.hidden = s.value !== 'part'; });
      q('#addx').onclick = () => { read(); jc.extra_tasks.push({ text: '', area: '', notes: '' }); draw(); };
      q('#pq').onchange = e => { read(); const v = e.target.value; if (!v) return; jc.plant.push({ item: v === '__other' ? '' : v, hours: null, notes: '' }); draw(); };
      q('#ph') && (q('#ph').onchange = async e => {
        read();
        for (const f of e.target.files) {
          try { const blob = await shrink(f); const path = `${project.id}/jc-${date}-${uid()}.jpg`; await store.upload('photos', path, blob); jc.photos.push({ path, at: new Date().toISOString() }); photoUrls[path] = URL.createObjectURL(blob); }
          catch (err) { toast('Photo upload failed: ' + err.message); }
        }
        draw();
      });
      q('#save').onclick = async () => { await save(); toast('Jobcard saved'); };
      q('#submit').onclick = async () => {
        read();
        if (!jc.staff.length && !jc.subbies.length && !(await confirmDlg('No staff ticked', 'Submit without anyone on site?', 'Submit anyway'))) return;
        const noC = [...jc.staff.filter(s => s.staff_id && !cOf(s.staff_id).ok), ...jc.subbies.filter(s => !cOf(s.person_id).ok)].map(s => s.name);
        if (noC.length && !(await confirmDlg('Some people have no contract', `${noC.join(', ')} ${noC.length === 1 ? 'has' : 'have'} no signed contract. Use “Sign contract” first, or submit anyway and Matt will see it flagged.`, 'Submit anyway'))) return;
        const sig = await captureSignature('Supervisor signature', D.staffBy[jc.supervisor_id]?.name || ctx.me?.full_name || '');
        if (!sig) return toast('A signature is needed to submit.');
        await save({ status: 'submitted', supervisor_sign: sig });
        // progress → programme
        for (const t of jc.tasks) {
          const task = D.tasks.find(x => x.id === t.task_id); if (!task) continue;
          const pct = t.state === 'done' ? 100 : Math.max(Number(task.pct) || 0, Number(t.pct) || 0);
          const status = pct >= 100 ? 'done' : (t.state || pct > 0) && t.state !== 'not_started' ? 'in_progress' : task.status;
          if (pct !== Number(task.pct) || status !== task.status) await store.update('tasks', task.id, { pct, status });
        }
        // deliveries → purchase orders
        await applyDeliveries(store, D, jc.deliveries, ctx.me);
        toast('Jobcard submitted'); ctx.reload();
      };
    } else {
      q('#approve') && (q('#approve').onclick = async () => { await store.update('jobcards', card.id, { status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: ctx.me?.id && ctx.me.id !== 'demo-user' ? ctx.me.id : null }); toast('Jobcard approved'); ctx.reload(); });
      q('#reopen') && (q('#reopen').onclick = async () => { await store.update('jobcards', card.id, { status: 'draft' }); toast('Sent back to the supervisor'); ctx.reload(); });
    }
    el.querySelectorAll('[data-sign]').forEach(b => b.onclick = async () => {
      read(); const person = D.staffBy[b.dataset.sign]; const r = cOf(person.id);
      const c = await startContract(ctx, { person, project, areas: D.areas, contract: r.state === 'draft' ? r.c : null });
      if (c && c !== 'deleted') { D.contracts = [...D.contracts.filter(x => x.id !== c.id), c]; }
      if (c === 'deleted') D.contracts = D.contracts.filter(x => x.id !== r.c?.id);
      draw();
    });
    q('#req').onclick = async () => { read(); if (await newRequest(ctx, D, { requested_by: D.staffBy[jc.supervisor_id]?.name })) toast('Request sent to Matt'); };
  };
  draw();
}

// Deliveries on a submitted jobcard update the purchase orders: full → every line received; part → the quantities entered.
export async function applyDeliveries(store, D, deliveries, me) {
  for (const d of (deliveries || []).filter(d => d.po_id && d.state)) {
    const p = D.pos.find(x => x.id === d.po_id); if (!p || p.status === 'received') continue;
    const lines = D.poLines.filter(l => l.po_id === p.id);
    if (d.state === 'full') { for (const l of lines) if (Number(l.qty_received) !== Number(l.qty)) await store.update('po_lines', l.id, { qty_received: Number(l.qty) }); await poAct(store, p, 'receive', me); continue; }
    for (const x of d.lines || []) { const l = lines.find(y => y.id === x.po_line_id); if (l) { l.qty_received = (Number(l.qty_received) || 0) + Number(x.qty); await store.update('po_lines', l.id, { qty_received: l.qty_received }); } }
    const all = lines.length && lines.every(l => (Number(l.qty_received) || 0) >= Number(l.qty) - 1e-9);
    if (all) await poAct(store, p, 'receive', me); else await store.update('purchase_orders', p.id, { status: 'part' });
  }
}

async function shrink(file, max = 1600) {
  const bmp = await createImageBitmap(file); const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
}

// ---------------------------------------------------- site instructions
function siList(el, ctx, D) {
  const { project } = ctx;
  const list = [...D.sis].reverse();
  el.innerHTML = `<section class="card"><div class="hd"><h3>Site instructions</h3><span class="small muted">Instructions given on site by the client or their team, signed by the person instructing.</span><span class="grow"></span><button class="btn primary" id="new">+ New site instruction</button></div>
    ${list.length ? `<div class="tbl"><table><thead><tr><th>SI</th><th>Instructed by</th><th>Instruction</th><th class="n">Est. value</th><th>Signed</th><th>Status</th></tr></thead><tbody>
    ${list.map(s => `<tr class="click" data-si="${s.id}"><td><b>${esc(s.number)}</b><div class="small muted">${fmtDate(s.si_date)}</div></td><td>${esc(s.instructed_by || '')}<div class="small muted">${esc([s.instructor_role, s.instructor_company].filter(Boolean).join(' · '))}</div></td>
      <td class="small">${esc((s.description || '').slice(0, 110))}</td><td class="n">${s.cost_impact ? money(Number(s.est_value) || 0) : '–'}</td><td>${s.signature ? '✍ Yes' : '<span class="flag">No</span>'}</td><td>${siPill(s.status)}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty"><b>No site instructions</b>When someone instructs a change on site, record it here and have them sign on the phone.</div>'}</section>`;
  el.querySelector('#new').onclick = () => editSI(ctx, D, null);
  el.querySelectorAll('[data-si]').forEach(r => r.onclick = () => editSI(ctx, D, D.sis.find(s => s.id === r.dataset.si)));
}

export async function editSI(ctx, D, si) {
  const { store, project } = ctx;
  const draft = { ...(si || { si_date: today(), status: 'open', cost_impact: false, photos: [] }) };
  const canDecide = ['admin', 'qs'].includes(ctx.me?.role);
  const body = () => `
    <div class="grid3"><label class="f">Date<input name="si_date" type="date" value="${esc(draft.si_date)}"></label>
      <label class="f span2">Area<select name="area_id"><option value="">Whole site</option>${D.areas.map(a => `<option value="${a.id}" ${draft.area_id === a.id ? 'selected' : ''}>${esc(a.code || '')} ${esc(a.name || a.type || '')}</option>`).join('')}</select></label></div>
    <div class="grid3"><label class="f">Instructed by (name)<input name="instructed_by" value="${esc(draft.instructed_by)}" required></label>
      <label class="f">Their role<select name="instructor_role">${SI_ROLES.map(r => `<option ${draft.instructor_role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label class="f">Company / department<input name="instructor_company" value="${esc(draft.instructor_company || project.client || '')}"></label></div>
    <label class="f">Instruction<textarea name="description" rows="4" placeholder="Exactly what was instructed">${esc(draft.description)}</textarea></label>
    <div class="grid3"><label class="chk"><input type="checkbox" name="cost_impact" ${draft.cost_impact ? 'checked' : ''}> Affects cost (variation)</label>
      <label class="f">Estimated value (E)<input name="est_value" inputmode="decimal" value="${draft.est_value ?? ''}"></label>
      <label class="f">Time impact (days)<input name="time_days" inputmode="decimal" value="${draft.time_days ?? ''}"></label></div>
    <label class="f">Recorded by<input name="recorded_by" value="${esc(draft.recorded_by || ctx.me?.full_name || '')}"></label>
    <div class="dims"><div class="row"><b style="font-family:var(--display)">Signature of person instructing</b><span class="grow"></span><button class="btn small primary" type="button" id="sign">${draft.signature ? 'Sign again' : 'Sign now'}</button></div>
      ${draft.signature ? `<img alt="Signature" src="${draft.signature}" style="height:90px;background:#fff;border:1px solid var(--line);border-radius:8px;align-self:flex-start"><div class="small muted">Signed ${draft.signed_at ? new Date(draft.signed_at).toLocaleString('en-GB') : ''}</div>` : '<div class="small muted">Hand the phone to the person giving the instruction.</div>'}</div>
    ${si && canDecide ? `<div class="grid2"><label class="f">Status<select name="status">${Object.entries(SI_STATUS).map(([k, l]) => `<option value="${k}" ${draft.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label class="f">Response / pricing note<input name="response" value="${esc(draft.response || '')}"></label></div>` : ''}`;
  const read = w => { const f = formData(w); Object.assign(draft, { si_date: f.si_date, area_id: f.area_id || null, instructed_by: f.instructed_by, instructor_role: f.instructor_role, instructor_company: f.instructor_company, description: f.description, cost_impact: !!f.cost_impact || num(f.est_value) > 0, est_value: num(f.est_value), time_days: num(f.time_days), recorded_by: f.recorded_by, ...(f.status ? { status: f.status } : {}), ...(f.response != null ? { response: f.response } : {}) }); };
  const wire = w => { w.querySelector('#sign').onclick = async () => { read(w); const s = await captureSignature('Sign the site instruction', draft.instructed_by); if (s) { draft.signature = s; draft.signed_at = new Date().toISOString(); if (draft.status === 'open') draft.status = 'signed'; } w.querySelector('.dlg-body').innerHTML = body(); wire(w); }; };
  const v = await dialog({ title: si ? si.number : 'New site instruction', wide: true, body: body(), onOpen: wire,
    buttons: [...(si ? [{ label: 'Delete', danger: true, value: 'delete' }, { label: 'Print', value: 'print' }] : []), { label: 'Cancel', value: null }, { label: 'Save', primary: true, value: w => { read(w); return 'save'; }, validate: w => !!w.querySelector('[name=instructed_by]').value.trim() && !!w.querySelector('[name=description]').value.trim() }] });
  if (!v) return;
  if (v === 'print') return openSiDoc(project, si, D);
  if (v === 'delete') { if (await confirmDlg('Delete site instruction?', si.number)) { await store.remove('site_instructions', si.id); ctx.reload(); } return; }
  const row = { ...draft, project_id: project.id }; delete row.id; delete row.created_at; delete row.created_by;
  if (!si) row.number = `SI-${(project.code || project.name).replace(/[^A-Za-z0-9]+/g, '').slice(0, 8).toUpperCase()}-${String(D.sis.length + 1).padStart(3, '0')}`;
  const out = si ? await store.update('site_instructions', si.id, row) : await store.insert('site_instructions', row);
  toast(`${out.number} saved`); ctx.reload();
}

// ------------------------------------------------------------ requests
function reqList(el, ctx, D) {
  const list = [...D.reqs].reverse();
  const canDecide = ctx.me?.role === 'admin';
  el.innerHTML = `<section class="card"><div class="hd"><h3>Requests from site</h3><span class="small muted">Materials, plant, labour or decisions the supervisor needs.</span><span class="grow"></span><button class="btn primary" id="new">+ New request</button></div>
    ${list.length ? `<div class="tbl"><table><thead><tr><th>Date</th><th>Type</th><th>Request</th><th>Needed by</th><th>From</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(r => `<tr><td>${fmtDate(r.created_at)}</td><td>${esc(r.kind)}</td><td><b>${esc(r.description)}</b>${r.items ? `<div class="small muted">${esc(r.items)}</div>` : ''}${r.response ? `<div class="small">↳ ${esc(r.response)}</div>` : ''}</td>
      <td>${r.needed_by ? fmtDate(r.needed_by) : '–'}</td><td class="small">${esc(r.requested_by || '')}</td><td>${reqPill(r.status)}</td>
      <td class="n">${canDecide && r.status === 'pending' ? `<button class="btn small primary" data-dec="approved" data-r="${r.id}">Approve</button> <button class="btn small" data-dec="declined" data-r="${r.id}">Decline</button>` : r.status === 'approved' ? `<button class="btn small" data-dec="done" data-r="${r.id}">Mark done</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty"><b>No requests</b>Supervisors can request materials, plant or labour here or from the daily jobcard.</div>'}</section>`;
  el.querySelector('#new').onclick = async () => { if (await newRequest(ctx, D, {})) ctx.reload(); };
  el.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => decideRequest(ctx, D.reqs.find(r => r.id === b.dataset.r), b.dataset.dec));
}

export async function decideRequest(ctx, r, decision) {
  let response = r.response || '';
  if (decision !== 'done') {
    const v = await dialog({ title: `${decision === 'approved' ? 'Approve' : 'Decline'} request`, body: `<p><b>${esc(r.description)}</b></p><label class="f">Reply to the supervisor (optional)<input name="r" value="${esc(response)}"></label>`, buttons: [{ label: 'Cancel', value: null }, { label: decision === 'approved' ? 'Approve' : 'Decline', primary: decision === 'approved', danger: decision !== 'approved', value: w => w.querySelector('[name=r]').value }] });
    if (v == null) return; response = v;
  }
  await ctx.store.update('requests', r.id, { status: decision, response, decided_at: new Date().toISOString(), decided_by: ctx.me?.id && ctx.me.id !== 'demo-user' ? ctx.me.id : null });
  toast({ approved: 'Approved', declined: 'Declined', done: 'Marked done' }[decision]); ctx.reload();
}

export async function newRequest(ctx, D, pre) {
  const { store, project } = ctx;
  const v = await dialog({
    title: 'New request', body: `<div class="grid2"><label class="f">Type<select name="kind">${REQ_KINDS.map(k => `<option>${k}</option>`).join('')}</select></label><label class="f">Needed by<input name="needed_by" type="date" value="${addDays(today(), 2)}"></label></div>
      <label class="f">What do you need?<input name="description" required placeholder="e.g. 3 loads topsoil for G4"></label>
      <label class="f">Details / quantities<textarea name="items"></textarea></label>
      <label class="f">Requested by<input name="requested_by" value="${esc(pre.requested_by || ctx.me?.full_name || '')}"></label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Send request', primary: true, value: w => formData(w), validate: w => !!w.querySelector('[name=description]').value.trim() }],
  });
  if (!v) return null;
  return store.insert('requests', { project_id: project.id, kind: v.kind, description: v.description.trim(), items: v.items || null, needed_by: v.needed_by || null, requested_by: v.requested_by || null, status: 'pending' });
}
