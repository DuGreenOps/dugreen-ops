// Home dashboard: everything across projects that needs a decision, plus project status and money at a glance.
import { esc, fmt, money, toast, today, fmtDate, addDays, groupBy } from './util.js';
import { isOverdue, activeOn, progress } from './pow.js';
import { projectFinancials } from './costs.js';
import { poAct, statusPill } from './procure.js';
import { decideRequest, siPill, reqPill } from './site.js';

export async function render(app, ctx) {
  const { store, me } = ctx;
  const [projects, tasks, pos, poLines, reqs, sis, jobcards, staff, suppliers] = await Promise.all([
    store.list('projects', {}, 'created_at'), store.list('tasks', {}, null), store.list('purchase_orders', {}, null), store.list('po_lines', {}, null),
    store.list('requests', {}, null), store.list('site_instructions', {}, null), store.list('jobcards', {}, null), store.list('staff', {}, 'name'), store.list('suppliers', {}, null)]);
  const P = Object.fromEntries(projects.map(p => [p.id, p])), sup = Object.fromEntries(suppliers.map(s => [s.id, s])), staffBy = Object.fromEntries(staff.map(s => [s.id, s]));
  const live = projects.filter(p => !['complete'].includes(p.status));
  const t0 = today();
  const overdue = tasks.filter(t => P[t.project_id] && isOverdue(t)).sort((a, b) => a.end_date.localeCompare(b.end_date));
  const pendPO = pos.filter(p => p.status === 'pending' && P[p.project_id]);
  const pendReq = reqs.filter(r => r.status === 'pending' && P[r.project_id]);
  const openSI = sis.filter(s => ['open', 'signed', 'priced'].includes(s.status) && P[s.project_id]);
  const toReview = jobcards.filter(j => j.status === 'submitted' && P[j.project_id]);
  const poValue = po => poLines.filter(l => l.po_id === po.id).reduce((t, l) => t + Number(l.qty) * Number(l.unit_price), 0);
  const isAdmin = me?.role === 'admin';
  const meStaff = staff.find(s => s.user_email && s.user_email === (me?.email || '').toLowerCase());

  // Supervisor home: today's work first.
  const myToday = tasks.filter(t => P[t.project_id] && activeOn(t, t0) && (!meStaff || t.supervisor_id === meStaff.id));
  const fin = {};
  if (me?.role !== 'supervisor') for (const p of live.slice(0, 12)) { try { fin[p.id] = await projectFinancials(store, p); } catch (e) { } }

  const hello = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';
  const card = (title, count, body, link) => `<section class="card"><div class="hd"><h3>${title}</h3><span class="pill ${count ? 'warn' : 'ok'}">${count || 'None'}</span><span class="grow"></span>${link || ''}</div>${body}</section>`;
  const list = (rows, empty) => rows.length ? `<div class="tbl"><table><tbody>${rows.join('')}</tbody></table></div>` : `<div class="empty small">${empty}</div>`;

  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div><h1>${hello}${me?.full_name ? ', ' + esc(me.full_name.split(' ')[0]) : ''}</h1></div>
      <div class="row"><a class="btn" href="#/projects">All projects</a>${me?.role !== 'supervisor' ? '<button class="btn primary" id="np">+ New installation project</button>' : ''}</div></div>
    <div class="kpis" style="grid-template-columns:repeat(6,minmax(0,1fr))">
      <div class="kpi"><div class="k">Live projects</div><div class="v">${live.length}</div></div>
      <div class="kpi"><div class="k">Overdue tasks</div><div class="v" style="${overdue.length ? 'color:var(--bad)' : ''}">${overdue.length}</div></div>
      <div class="kpi"><div class="k">POs to approve</div><div class="v" style="${pendPO.length ? 'color:var(--warn)' : ''}">${pendPO.length}</div></div>
      <div class="kpi"><div class="k">Site requests</div><div class="v" style="${pendReq.length ? 'color:var(--warn)' : ''}">${pendReq.length}</div></div>
      <div class="kpi"><div class="k">Open SIs</div><div class="v">${openSI.length}</div></div>
      <div class="kpi"><div class="k">Jobcards to review</div><div class="v">${toReview.length}</div></div>
    </div>

    ${me?.role === 'supervisor' || myToday.length ? `<section class="card"><div class="hd"><h3>${meStaff ? 'Your work today' : 'Work planned today'}</h3><span class="small muted">${myToday.length} tasks</span></div>
      ${list(Object.entries(groupBy(myToday, t => t.project_id)).map(([pid, ts]) => `<tr><td><b>${esc(P[pid].name)}</b><div class="small muted">${ts.map(t => esc(t.name)).join(' · ')}</div></td>
        <td class="n"><a class="btn small primary" href="#/p/${pid}/site/jobcard/${t0}${meStaff ? '?s=' + meStaff.id : ''}">Today's jobcard</a> <a class="btn small" href="#/p/${pid}/site/si">Site instruction</a></td></tr>`), 'Nothing planned today.')}</section>` : ''}

    <div class="grid2" style="align-items:start">
      ${card('Purchase orders awaiting approval', pendPO.length, list(pendPO.map(po => `<tr><td><b>${esc(po.number)}</b> · ${esc(sup[po.supplier_id]?.name || '')}<div class="small muted">${esc(P[po.project_id].name)}</div></td><td class="n">${money(poValue(po) * (1 + Number(po.vat_rate ?? 0.15)), 0)}<div class="small muted">incl. VAT</div></td>
        <td class="n"><a class="btn small" href="#/p/${po.project_id}/procure/po/${po.id}">Open</a>${isAdmin ? ` <button class="btn small primary" data-poa="${po.id}">Approve</button>` : ''}</td></tr>`), 'No purchase orders waiting.'))}
      ${card('Requests from site', pendReq.length, list(pendReq.map(r => `<tr><td><b>${esc(r.description)}</b><div class="small muted">${esc(r.kind)} · ${esc(P[r.project_id].name)} · ${esc(r.requested_by || '')}${r.needed_by ? ' · needed ' + fmtDate(r.needed_by) : ''}</div></td>
        <td class="n">${isAdmin ? `<button class="btn small primary" data-req="${r.id}" data-dec="approved">Approve</button> <button class="btn small" data-req="${r.id}" data-dec="declined">Decline</button>` : reqPill(r.status)}</td></tr>`), 'No pending requests.'))}
      ${card('Overdue tasks', overdue.length, list(overdue.slice(0, 12).map(t => `<tr class="click" data-go="#/p/${t.project_id}/pow"><td><b>${esc(t.name)}</b><div class="small muted">${esc(P[t.project_id].name)}${staffBy[t.supervisor_id] ? ' · ' + esc(staffBy[t.supervisor_id].name) : ''}</div></td><td class="n"><span class="flag">due ${fmtDate(t.end_date)}</span><div class="small muted">${fmt(t.pct || 0)}% done</div></td></tr>`), 'Everything is on time.'))}
      ${card('Jobcards to review', toReview.length, list(toReview.map(j => `<tr class="click" data-go="#/p/${j.project_id}/site/jobcard/${j.card_date}${j.supervisor_id ? '?s=' + j.supervisor_id : ''}"><td><b>${esc(P[j.project_id].name)}</b><div class="small muted">${fmtDate(j.card_date)} · ${esc(staffBy[j.supervisor_id]?.name || '')}${j.issues ? ' · ⚠ issues reported' : ''}</div></td><td class="n">${(j.staff || []).reduce((t, s) => t + (Number(s.count) || 1), 0)} staff</td></tr>`), 'No jobcards waiting.'))}
      ${card('Site instructions in progress', openSI.length, list(openSI.map(s => `<tr class="click" data-go="#/p/${s.project_id}/site/si"><td><b>${esc(s.number)}</b> · ${esc(s.instructed_by || '')}<div class="small muted">${esc(P[s.project_id].name)} · ${esc((s.description || '').slice(0, 70))}</div></td><td class="n">${s.cost_impact ? money(Number(s.est_value) || 0, 0) : ''} ${siPill(s.status)}</td></tr>`), 'No open site instructions.'))}
      ${card("Today's site diaries", 0, list(live.filter(p => tasks.some(t => t.project_id === p.id && activeOn(t, t0))).map(p => { const j = jobcards.find(x => x.project_id === p.id && x.card_date === t0); return `<tr class="click" data-go="#/p/${p.id}/site/jobcard/${t0}"><td><b>${esc(p.name)}</b></td><td class="n">${j ? (j.status === 'draft' ? '<span class="pill warn">In progress</span>' : '<span class="pill ok">Submitted</span>') : '<span class="pill mute">Not started</span>'}</td></tr>`; }), 'No work planned on site today.'))}
    </div>

    ${me?.role !== 'supervisor' ? `<section class="card"><div class="hd"><h3>Projects</h3><span class="small muted">Money excludes VAT</span></div>
      ${live.length ? `<div class="tbl"><table><thead><tr><th>Project</th><th>Progress</th><th class="n">Contract</th><th class="n">Actual cost</th><th class="n">Forecast margin</th><th class="n">Outstanding</th><th>Next deadline</th></tr></thead><tbody>
      ${live.map(p => { const f = fin[p.id]; const pt = tasks.filter(t => t.project_id === p.id); const next = pt.filter(t => t.status !== 'done' && t.end_date >= t0).sort((a, b) => a.end_date.localeCompare(b.end_date))[0]; const pr = progress(pt);
        return `<tr class="click" data-go="#/p/${p.id}/costs"><td><b>${esc(p.name)}</b><div class="small muted">${esc(p.client || '')}${p.code ? ' · ' + esc(p.code) : ''}</div></td>
          <td style="min-width:120px"><div class="small">${fmt(pr * 100)}%${pt.some(t => isOverdue(t)) ? ' · <span class="flag">overdue</span>' : ''}</div><div style="height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden"><i style="display:block;height:100%;width:${(pr * 100).toFixed(0)}%;background:var(--ok)"></i></div></td>
          <td class="n">${f ? money(f.revenue, 0) : '–'}</td><td class="n">${f ? money(f.actual, 0) : '–'}</td>
          <td class="n" style="color:${f && f.margin < 0 ? 'var(--bad)' : 'inherit'}">${f && f.revenue ? `${money(f.margin, 0)}<div class="small muted">${fmt(f.marginPct * 100, 1)}%</div>` : '–'}</td>
          <td class="n">${f && f.certified - f.paid > 0 ? money(f.certified - f.paid, 0) : '–'}</td>
          <td class="small">${next ? `${esc(next.name)}<div class="muted">${fmtDate(next.end_date)}</div>` : '–'}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="empty"><b>No projects yet</b>Create the office test site to get started.</div>'}</section>` : ''}
  </div>`;
  app.querySelector('#np')?.addEventListener('click', () => ctx.newProject());
  app.querySelectorAll('[data-go]').forEach(r => r.onclick = () => ctx.go(r.dataset.go));
  app.querySelectorAll('[data-poa]').forEach(b => b.onclick = async () => { await poAct(store, pos.find(p => p.id === b.dataset.poa), 'approve', me); ctx.reload(); });
  app.querySelectorAll('[data-req]').forEach(b => b.onclick = () => decideRequest(ctx, reqs.find(r => r.id === b.dataset.req), b.dataset.dec));
}
