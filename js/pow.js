// Programme of works: plan tasks by area, see them on a timeline, and send daily / weekly plans to supervisors.
import { esc, fmt, dialog, formData, toast, confirmDlg, num, today, fmtDate, addDays, daysBetween, weekStart, copyText, groupBy, typeColor } from './util.js';
import { sortAreas } from './areas.js';
import { openPlanDoc } from './docs.js';

export const TASK_STATUS = { planned: 'Planned', in_progress: 'In progress', done: 'Done', on_hold: 'On hold' };
export const PHASES = ['Site establishment', 'Clearing & demolition', 'Earthworks', 'Soil preparation', 'Irrigation', 'Hardscaping', 'Planting', 'Lawn & grassing', 'Finishing & mulch', 'Maintenance', 'Handover'];

// Working days: Monday–Saturday.
export function addWorkdays(start, n) {
  let d = start, left = Math.max(1, Math.round(n)) - 1;
  while (new Date(d + 'T00:00:00').getDay() === 0) d = addDays(d, 1);
  while (left > 0) { d = addDays(d, 1); if (new Date(d + 'T00:00:00').getDay() !== 0) left--; }
  return d;
}
export function workdays(a, b) { let n = 0; for (let d = a; d <= b; d = addDays(d, 1)) if (new Date(d + 'T00:00:00').getDay() !== 0) n++; return n; }
export const isOverdue = (t, on = today()) => t.status !== 'done' && t.end_date && t.end_date < on;
export const activeOn = (t, d) => t.status !== 'done' && t.start_date && t.start_date <= d && (t.end_date || t.start_date) >= d;
export function progress(tasks) {
  let w = 0, done = 0;
  for (const t of tasks) { const d = t.start_date && t.end_date ? Math.max(1, workdays(t.start_date, t.end_date)) : 1; w += d; done += d * (t.status === 'done' ? 100 : Number(t.pct) || 0) / 100; }
  return w ? done / w : 0;
}
// Where a task should be today if it ran to plan (0–1), to flag tasks running behind.
export function plannedPct(t, on = today()) {
  if (!t.start_date || !t.end_date || on < t.start_date) return 0;
  if (on >= t.end_date) return 1;
  // Share of working days fully elapsed before today (so a task starting today is not 'behind').
  return on <= t.start_date ? 0 : workdays(t.start_date, addDays(on, -1)) / Math.max(1, workdays(t.start_date, t.end_date));
}

const statusCls = t => isOverdue(t) ? 'bad' : t.status === 'done' ? 'ok' : t.status === 'in_progress' ? 'info' : t.status === 'on_hold' ? 'warn' : 'mute';
export const taskPill = t => `<span class="pill ${statusCls(t)}">${isOverdue(t) ? 'Overdue' : TASK_STATUS[t.status] || t.status}</span>`;

export async function render(root, ctx) {
  const { store, project } = ctx;
  const view = ctx.rest?.[0] || 'programme';
  const [tasksRaw, areasRaw, staff] = await Promise.all([store.list('tasks', { project_id: project.id }, 'sort'), store.list('areas', { project_id: project.id }), store.list('staff', {}, 'name')]);
  const areas = sortAreas(areasRaw), areaBy = Object.fromEntries(areas.map(a => [a.id, a])), staffBy = Object.fromEntries(staff.map(s => [s.id, s]));
  const tasks = [...tasksRaw].sort((a, b) => String(a.start_date || '9').localeCompare(String(b.start_date || '9')) || (a.sort || 0) - (b.sort || 0));
  const prog = progress(tasks), overdue = tasks.filter(t => isOverdue(t)).length;
  const wk = weekStart(today()), wkEnd = addDays(wk, 6);
  const dueWeek = tasks.filter(t => t.status !== 'done' && t.end_date >= wk && t.end_date <= wkEnd).length;
  root.innerHTML = `<div class="page">
    <div class="row"><div class="grow"><div class="eyebrow">Programme of works</div><h2 style="font-size:24px">Programme</h2></div>
      <nav class="subtabs"><a href="#/p/${project.id}/pow" class="${view === 'programme' ? 'on' : ''}">Programme</a><a href="#/p/${project.id}/pow/plan" class="${view === 'plan' ? 'on' : ''}">Daily & weekly plans</a></nav></div>
    <div class="kpis">
      <div class="kpi"><div class="k">Tasks</div><div class="v">${tasks.length}</div></div>
      <div class="kpi"><div class="k">Complete</div><div class="v">${fmt(prog * 100)}%</div><div class="bar" style="height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden;margin-top:6px"><i style="display:block;height:100%;width:${(prog * 100).toFixed(1)}%;background:var(--ok)"></i></div></div>
      <div class="kpi"><div class="k">Overdue</div><div class="v" style="${overdue ? 'color:var(--bad)' : ''}">${overdue}</div></div>
      <div class="kpi"><div class="k">Due this week</div><div class="v">${dueWeek}</div></div>
    </div>
    <div id="pv"></div></div>`;
  const el = root.querySelector('#pv');
  const D = { tasks, areas, areaBy, staff, staffBy };
  if (view === 'plan') return planView(el, ctx, D);
  programmeView(el, ctx, D);
}

function programmeView(el, ctx, D) {
  const { store, project } = ctx;
  const { tasks, areaBy, staffBy } = D;
  const dated = tasks.filter(t => t.start_date);
  let start = dated.length ? dated.reduce((m, t) => t.start_date < m ? t.start_date : m, dated[0].start_date) : today();
  let end = dated.length ? dated.reduce((m, t) => (t.end_date || t.start_date) > m ? (t.end_date || t.start_date) : m, dated[0].end_date || dated[0].start_date) : addDays(today(), 27);
  start = weekStart(start < today() ? start : today()); end = addDays(weekStart(end), 6);
  const days = daysBetween(start, end) + 1, DW = 22;
  const weeks = []; for (let d = start; d <= end; d = addDays(d, 7)) weeks.push(d);
  const x = d => daysBetween(start, d) * DW;
  const groups = groupBy(tasks, t => t.phase || 'Other');
  const order = Object.keys(groups).sort((a, b) => (PHASES.indexOf(a) + 1 || 99) - (PHASES.indexOf(b) + 1 || 99));
  el.innerHTML = `<section class="card"><div class="hd"><h3>Tasks</h3><span class="small muted">Working days are Monday to Saturday.</span><span class="grow"></span>
      ${D.areas.length ? '<button class="btn" id="gen">Create tasks from areas</button>' : ''}
      <button class="btn" id="print">Print programme</button><button class="btn primary" id="add">+ Add task</button></div>
    ${tasks.length ? `<div class="tbl" style="max-height:none"><div style="display:grid;grid-template-columns:minmax(220px,300px) ${days * DW}px;min-width:${260 + days * DW}px">
      <div style="position:sticky;left:0;background:var(--surface);z-index:2;border-bottom:1px solid var(--line);padding:6px 10px" class="small muted">Task</div>
      <div style="position:relative;height:30px;border-bottom:1px solid var(--line)">${weeks.map(w => `<div class="small muted" style="position:absolute;left:${x(w) + 4}px;top:7px;white-space:nowrap">${new Date(w + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</div>`).join('')}</div>
      ${order.map(ph => `<div class="small" style="position:sticky;left:0;background:var(--surface-2);z-index:1;padding:5px 10px;font:700 12px var(--display);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">${esc(ph)}</div><div style="background:var(--surface-2)"></div>` +
        groups[ph].map(t => {
          const a = areaBy[t.area_id];
          const s = t.start_date, e = t.end_date || t.start_date;
          const behind = t.status !== 'done' && (Number(t.pct) || 0) / 100 + 0.05 < plannedPct(t);
          return `<div class="click" data-t="${t.id}" style="position:sticky;left:0;background:var(--surface);z-index:1;padding:6px 10px;border-bottom:1px solid var(--line);cursor:pointer">
              <div style="font-weight:600;line-height:1.25">${a ? `<span class="code" style="background:${typeColor(a.type)};font-size:11px;padding:2px 5px">${esc(a.code || '')}</span> ` : ''}${esc(t.name)}</div>
              <div class="small muted">${s ? `${fmtDate(s)} – ${fmtDate(e)}` : 'Not scheduled'}${staffBy[t.supervisor_id] ? ' · ' + esc(staffBy[t.supervisor_id].name) : ''} · ${taskPill(t)}${behind ? ' <span class="pill warn">Behind plan</span>' : ''}</div></div>
            <div style="position:relative;border-bottom:1px solid var(--line);background:repeating-linear-gradient(90deg,transparent 0 ${DW * 7 - 1}px,var(--line) ${DW * 7 - 1}px ${DW * 7}px)">
              ${today() >= start && today() <= end ? `<div style="position:absolute;left:${x(today()) + DW / 2}px;top:0;bottom:0;width:2px;background:var(--bad);opacity:.55"></div>` : ''}
              ${s ? `<div data-t="${t.id}" title="${esc(t.name)} · ${fmt(t.status === 'done' ? 100 : t.pct || 0)}% complete" style="position:absolute;top:12px;height:20px;left:${x(s)}px;width:${(daysBetween(s, e) + 1) * DW - 3}px;border-radius:5px;background:color-mix(in srgb,var(--${statusCls(t) === 'mute' ? 'muted' : statusCls(t) === 'bad' ? 'bad' : statusCls(t) === 'ok' ? 'ok' : statusCls(t) === 'warn' ? 'warn' : 'info'}) 28%,var(--surface));overflow:hidden;cursor:pointer">
                <i style="display:block;height:100%;width:${t.status === 'done' ? 100 : Number(t.pct) || 0}%;background:var(--${statusCls(t) === 'bad' ? 'bad' : statusCls(t) === 'ok' ? 'ok' : 'info'})"></i></div>` : ''}
            </div>`;
        }).join('')).join('')}
    </div></div><div class="small muted" style="padding:8px 14px">Red line = today. Bars fill as work is reported complete.</div>` : `<div class="empty"><b>No tasks yet</b>Add the works in order (clearing, earthworks, irrigation, planting…), or create one task per area to start from.</div>`}</section>`;
  const $ = s => el.querySelector(s);
  $('#add').onclick = async () => { if (await editTask(ctx, null, D)) ctx.reload(); };
  el.querySelectorAll('[data-t]').forEach(r => r.onclick = async () => { if (await editTask(ctx, tasks.find(t => t.id === r.dataset.t), D)) ctx.reload(); });
  $('#print').onclick = () => openPlanDoc(project, 'Programme of works', tasks, D, null);
  $('#gen') && ($('#gen').onclick = async () => {
    const v = await dialog({
      title: 'Create tasks from areas', body: `<p class="muted">Adds one task per area that has no task yet, one after another.</p>
        <div class="grid2"><label class="f">Start date<input name="s" type="date" value="${today()}"></label><label class="f">Working days per area<input name="d" inputmode="decimal" value="3"></label></div>
        <label class="f">Phase<select name="p">${PHASES.map(p => `<option ${p === 'Planting' ? 'selected' : ''}>${p}</option>`).join('')}</select></label>`,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Create tasks', primary: true, value: w => formData(w) }],
    });
    if (!v) return;
    let s = v.s || today(); const n = num(v.d) || 3; const rows = [];
    for (const a of D.areas.filter(a => !tasks.some(t => t.area_id === a.id))) {
      const e = addWorkdays(s, n);
      rows.push({ project_id: project.id, area_id: a.id, name: `${a.name || a.type || 'Area'} works`, phase: v.p, start_date: s, end_date: e, status: 'planned', pct: 0, sort: tasks.length + rows.length });
      s = addWorkdays(addDays(e, 1), 1);
    }
    if (!rows.length) return toast('Every area already has a task.');
    await store.insert('tasks', rows); toast(`Created ${rows.length} tasks`); ctx.reload();
  });
}

export async function editTask(ctx, t, D) {
  const { store, project } = ctx;
  const sups = [...D.staff.filter(s => s.active !== false && /supervisor|leader/i.test(s.role || '')), ...D.staff.filter(s => s.active !== false && !/supervisor|leader/i.test(s.role || ''))];
  const dur = t?.start_date && t?.end_date ? workdays(t.start_date, t.end_date) : 1;
  const v = await dialog({
    title: t ? 'Task' : 'Add task', wide: true,
    body: `<label class="f">Task<input name="name" required value="${esc(t?.name)}" placeholder="e.g. Strip and level, install drip line, plant G4"></label>
      <div class="grid2"><label class="f">Phase<input name="phase" list="dl-ph" value="${esc(t?.phase || '')}"><datalist id="dl-ph">${PHASES.map(p => `<option>${p}</option>`).join('')}</datalist></label>
        <label class="f">Area<select name="area_id"><option value="">Whole site</option>${D.areas.map(a => `<option value="${a.id}" ${t?.area_id === a.id ? 'selected' : ''}>${esc(a.code || '')} ${esc(a.name || a.type || '')}</option>`).join('')}</select></label></div>
      <div class="grid3"><label class="f">Start<input name="start_date" type="date" value="${esc(t?.start_date || today())}"></label>
        <label class="f">Working days<input name="dur" inputmode="decimal" value="${dur}"></label>
        <label class="f">Finish<input name="end_date" type="date" value="${esc(t?.end_date || '')}"></label></div>
      <label class="f">Starts after<select name="depends_on"><option value="">—</option>${D.tasks.filter(x => x.id !== t?.id).map(x => `<option value="${x.id}" ${t?.depends_on === x.id ? 'selected' : ''}>${esc(x.name)} (ends ${fmtDate(x.end_date)})</option>`).join('')}</select></label>
      <div class="grid3"><label class="f">Supervisor<select name="supervisor_id"><option value="">—</option>${sups.map(s => `<option value="${s.id}" ${t?.supervisor_id === s.id ? 'selected' : ''}>${esc(s.name)} · ${esc(s.role || '')}</option>`).join('')}</select></label>
        <label class="f">Crew size<input name="crew" inputmode="numeric" value="${t?.crew ?? ''}"></label>
        <label class="f">Status<select name="status">${Object.entries(TASK_STATUS).map(([k, l]) => `<option value="${k}" ${(t?.status || 'planned') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <label class="f">% complete <input name="pct" type="range" min="0" max="100" step="5" value="${t?.pct ?? 0}"><span class="small" id="pctv">${fmt(t?.pct ?? 0)}%</span></label>
      <label class="f">Notes / instructions for the supervisor<textarea name="notes">${esc(t?.notes)}</textarea></label>
      ${D.staff.length ? '' : '<p class="note">Add supervisors in the <a href="#/staff">Staff register</a> to assign tasks to them.</p>'}`,
    onOpen: w => {
      const s = w.querySelector('[name=start_date]'), d = w.querySelector('[name=dur]'), e = w.querySelector('[name=end_date]'), dep = w.querySelector('[name=depends_on]');
      const fromDur = () => { if (s.value && num(d.value)) e.value = addWorkdays(s.value, num(d.value)); };
      if (!e.value) fromDur();
      s.onchange = fromDur; d.oninput = fromDur;
      e.onchange = () => { if (s.value && e.value >= s.value) d.value = workdays(s.value, e.value); };
      dep.onchange = () => { const p = D.tasks.find(x => x.id === dep.value); if (p?.end_date) { s.value = addWorkdays(addDays(p.end_date, 1), 1); fromDur(); } };
      const p = w.querySelector('[name=pct]'), pv = w.querySelector('#pctv'), st = w.querySelector('[name=status]');
      p.oninput = () => { pv.textContent = p.value + '%'; if (+p.value === 100) st.value = 'done'; else if (+p.value > 0 && st.value === 'planned') st.value = 'in_progress'; };
    },
    buttons: [...(t ? [{ label: 'Delete', danger: true, value: 'delete' }] : []), { label: 'Cancel', value: null }, { label: t ? 'Save' : 'Add task', primary: true, value: w => formData(w), validate: w => !!w.querySelector('[name=name]').value.trim() }],
  });
  if (!v) return null;
  if (v === 'delete') { if (await confirmDlg('Delete task?', t.name)) { await store.remove('tasks', t.id); return 'deleted'; } return null; }
  const row = { project_id: project.id, name: v.name.trim(), phase: v.phase || null, area_id: v.area_id || null, start_date: v.start_date || null, end_date: v.end_date || v.start_date || null,
    depends_on: v.depends_on || null, supervisor_id: v.supervisor_id || null, crew: num(v.crew), status: v.status, pct: v.status === 'done' ? 100 : num(v.pct) || 0, notes: v.notes || null };
  const out = t ? await store.update('tasks', t.id, row) : await store.insert('tasks', { ...row, sort: D.tasks.length });
  toast('Saved'); return out;
}

// ---------------------------------------------------------------- plans
export function planText(project, title, list, D, sup) {
  const byDay = groupBy(list, x => x.day);
  return `*Du Green – ${title}*\n${project.name}${sup ? `\nSupervisor: ${sup.name}` : ''}\n\n` + Object.entries(byDay).map(([d, xs]) =>
    `${new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short' })}\n` + xs.map(x => `• ${D.areaBy[x.t.area_id]?.code ? D.areaBy[x.t.area_id].code + ' – ' : ''}${x.t.name}${x.t.crew ? ` (crew ${x.t.crew})` : ''}${x.t.notes ? `\n   ${x.t.notes}` : ''}`).join('\n')).join('\n\n') +
    `\n\nPlease complete the daily jobcard in the app at the end of each day.`;
}

function planView(el, ctx, D) {
  const { project } = ctx;
  const meStaff = D.staff.find(s => s.user_email && s.user_email === (ctx.me?.email || '').toLowerCase());
  const qs = new URLSearchParams((location.hash.split('?')[1]) || '');
  const supId = qs.get('s') ?? (meStaff?.id || '');
  const period = qs.get('p') || 'week';
  const base = today();
  const range = { today: [base, base], tomorrow: [addDays(base, 1), addDays(base, 1)], week: [weekStart(base), addDays(weekStart(base), 5)], next: [addDays(weekStart(base), 7), addDays(weekStart(base), 12)] }[period];
  const list = [];
  for (let d = range[0]; d <= range[1]; d = addDays(d, 1)) {
    if (new Date(d + 'T00:00:00').getDay() === 0) continue;
    for (const t of D.tasks) if (activeOn(t, d) && (!supId || t.supervisor_id === supId)) list.push({ day: d, t });
  }
  const sup = D.staffBy[supId];
  const title = { today: 'Plan for today', tomorrow: 'Plan for tomorrow', week: 'Plan for this week', next: 'Plan for next week' }[period];
  const text = planText(project, title, list, D, sup);
  const link = p => `#/p/${project.id}/pow/plan?s=${encodeURIComponent(p.s ?? supId)}&p=${p.p ?? period}`;
  el.innerHTML = `<section class="card"><div class="hd"><h3>${title}</h3><span class="grow"></span>
      <label class="f" style="min-width:200px">Supervisor<select id="sup"><option value="">Everyone</option>${D.staff.filter(s => s.active !== false).map(s => `<option value="${s.id}" ${supId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label></div>
    <div class="bd stack">
      <nav class="subtabs">${[['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'This week'], ['next', 'Next week']].map(([k, l]) => `<a href="${link({ p: k })}" class="${period === k ? 'on' : ''}">${l}</a>`).join('')}</nav>
      ${list.length ? Object.entries(groupBy(list, x => x.day)).map(([d, xs]) => `<div><div class="cat-h">${new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short' })}
          <a class="btn small" style="margin-left:8px" href="#/p/${project.id}/site/jobcard/${d}${supId ? '?s=' + supId : ''}">Jobcard for this day</a></div>
        ${xs.map(x => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">${D.areaBy[x.t.area_id] ? `<span class="code" style="background:${typeColor(D.areaBy[x.t.area_id].type)}">${esc(D.areaBy[x.t.area_id].code || '')}</span>` : ''}<div class="grow"><b>${esc(x.t.name)}</b>${x.t.notes ? `<div class="small muted">${esc(x.t.notes)}</div>` : ''}</div><span class="small muted">${x.t.crew ? `crew ${x.t.crew} · ` : ''}${esc(D.staffBy[x.t.supervisor_id]?.name || 'unassigned')}</span>${taskPill(x.t)}</div>`).join('')}</div>`).join('')
        : '<div class="empty small">No tasks planned for this period. Add or schedule tasks on the Programme.</div>'}
      <div class="row"><span class="grow"></span>
        <button class="btn" id="cp">Copy plan</button>
        ${sup?.phone ? `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${esc(sup.phone.replace(/[^0-9]/g, ''))}?text=${encodeURIComponent(text)}">Send on WhatsApp</a>` : ''}
        <a class="btn" href="mailto:${esc(sup?.user_email || '')}?subject=${encodeURIComponent(title + ' – ' + project.name)}&body=${encodeURIComponent(text)}">Email</a>
        <button class="btn primary" id="pr">Print plan</button></div>
      ${!sup?.phone && supId ? '<p class="small muted">Add a phone number to this supervisor in the Staff register to send plans on WhatsApp.</p>' : ''}
    </div></section>`;
  el.querySelector('#sup').onchange = e => ctx.go(link({ s: e.target.value }));
  el.querySelector('#cp').onclick = async () => (await copyText(text)) ? toast('Plan copied') : toast('Copy failed');
  el.querySelector('#pr').onclick = () => openPlanDoc(project, title, list.map(x => ({ ...x.t, day: x.day })), D, sup);
}
