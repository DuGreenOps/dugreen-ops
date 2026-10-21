// Safety: daily toolbox talks (on the jobcard) and the incident register (injuries, near misses, damage).
import { esc, fmt, dialog, formData, toast, today, fmtDate, isManager } from './util.js';
import { photoInput, wirePhoto, photoUrls, thumb } from './photos.js';

export const TOOLBOX_TOPICS = ['PPE – wear it, check it', 'Brushcutter & mower safety', 'Chainsaw & hedge trimmer safety', 'Manual lifting & back care', 'Heat, sun & drinking water', 'Working near traffic / roads', 'Trenching & digging near services', 'Chemicals & fertiliser handling', 'Tool care & reporting damage', 'Housekeeping & tidy site', 'Working with TLB / plant nearby', 'Lightning & storms', 'First aid & reporting injuries', 'Theft & site security'];
export const INCIDENT_KINDS = ['Injury', 'Near miss', 'Property / equipment damage', 'Vehicle incident', 'Environmental (spill, fire)', 'Security / theft', 'Other'];
export const SEVERITY = ['Minor (first aid)', 'Medical treatment', 'Lost time', 'Serious'];
export const INC_STATUS = { open: 'Open', investigating: 'Investigating', closed: 'Closed' };
const incPill = s => `<span class="pill ${{ open: 'bad', investigating: 'warn', closed: 'ok' }[s] || 'mute'}">${esc(INC_STATUS[s] || s)}</span>`;

export async function reportIncident(ctx, { projectId, date = today(), people = [] }) {
  const { store, me } = ctx;
  const photos = [];
  const v = await dialog({
    title: 'Report a safety incident', wide: true, sticky: true,
    body: `<div class="grid3"><label class="f">Type<select name="kind">${INCIDENT_KINDS.map(k => `<option>${k}</option>`).join('')}</select></label><label class="f">Date<input type="date" name="inc_date" value="${date}"></label><label class="f">Time<input type="time" name="inc_time"></label></div>
      <div class="grid2"><label class="f">Person involved<input name="person" list="dl-ppl" placeholder="name"></label><label class="f">Severity<select name="severity">${SEVERITY.map(s => `<option>${s}</option>`).join('')}</select></label></div>
      <datalist id="dl-ppl">${people.map(p => `<option>${esc(p.name)}</option>`).join('')}</datalist>
      <label class="f">What happened<textarea name="description" rows="3" required></textarea></label>
      <label class="f">Injury / damage<input name="injury" placeholder="e.g. cut to left hand from secateurs"></label>
      <label class="f">Action taken<input name="action" placeholder="e.g. first aid given, taken to clinic, area cordoned off"></label>
      <label class="f">Witnesses<input name="witnesses"></label>
      <div class="row">${photoInput('incp', '📷 Add photo', true)}<span id="incv" class="row" style="gap:6px"></span></div>`,
    onOpen: w => wirePhoto(w, 'incp', store, 'incidents', p => { photos.push(p); w.querySelector('#incv').insertAdjacentHTML('beforeend', thumb(p.url, 'Incident photo', 56)); }),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Report', primary: true, value: w => formData(w), validate: w => !!w.querySelector('[name=description]').value.trim() }],
  });
  if (!v) return null;
  const out = await store.insert('incidents', { project_id: projectId, ...v, photos: photos.map(p => ({ path: p.path, at: p.at })), reported_by: me?.full_name || null, status: 'open' });
  toast('Incident reported to Matt and the Operations Manager'); return out;
}

export async function incidentsView(el, ctx, D) {
  const { store, project, me } = ctx;
  const list = (await store.list('incidents', { project_id: project.id }, 'inc_date')).reverse();
  const talks = D.jobcards.filter(j => j.toolbox?.held);
  const urls = await photoUrls(store, list.flatMap(i => (i.photos || []).slice(0, 1).map(p => p.path)));
  el.innerHTML = `<section class="card"><div class="hd"><h3>Incident register</h3><span class="grow"></span><button class="btn primary" id="new">+ Report incident</button></div>
    ${list.length ? `<div class="tbl"><table><thead><tr><th></th><th>Date</th><th>Type</th><th>What happened</th><th>Severity</th><th>Status</th></tr></thead><tbody>${list.map(i => `<tr class="click" data-i="${i.id}"><td>${thumb(urls[i.photos?.[0]?.path], 'Photo', 40)}</td><td class="small">${fmtDate(i.inc_date)}${i.inc_time ? ' ' + esc(i.inc_time) : ''}</td><td><b>${esc(i.kind)}</b><div class="small muted">${esc(i.person || '')}</div></td><td class="small">${esc((i.description || '').slice(0, 100))}</td><td class="small">${esc(i.severity || '')}</td><td>${incPill(i.status)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">No incidents reported on this project.</div>'}</section>
    <section class="card"><div class="hd"><h3>Toolbox talks</h3><span class="small muted">${talks.length} recorded on jobcards</span></div>
      ${talks.length ? `<div class="tbl"><table><tbody>${[...talks].reverse().map(j => `<tr><td class="small">${fmtDate(j.card_date)}</td><td>${esc(j.toolbox.topic || '')}</td><td class="small muted">${esc(j.toolbox.notes || '')}</td><td class="n small">${(j.staff || []).reduce((t, s) => t + (Number(s.count) || 1), 0)} attended</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">Record the daily toolbox talk on the jobcard.</div>'}</section>`;
  el.querySelector('#new').onclick = async () => { if (await reportIncident(ctx, { projectId: project.id, people: D.staff })) ctx.reload(); };
  el.querySelectorAll('[data-i]').forEach(r => r.onclick = async () => {
    const i = list.find(x => x.id === r.dataset.i); const u = await photoUrls(store, (i.photos || []).map(p => p.path));
    const v = await dialog({ title: `${i.kind} · ${fmtDate(i.inc_date)}`, wide: true,
      body: `<p><b>${esc(i.person || '')}</b> · ${esc(i.severity || '')}</p><p>${esc(i.description || '')}</p>${i.injury ? `<p class="small">Injury / damage: ${esc(i.injury)}</p>` : ''}${i.action ? `<p class="small">Action: ${esc(i.action)}</p>` : ''}${i.witnesses ? `<p class="small">Witnesses: ${esc(i.witnesses)}</p>` : ''}
        <div class="row">${(i.photos || []).map(p => u[p.path] ? `<a href="${u[p.path]}" target="_blank" rel="noopener">${thumb(u[p.path], 'Incident photo', 110)}</a>` : '').join('')}</div>
        ${isManager(me) || me?.role === 'admin' ? `<label class="f">Status<select name="status">${Object.entries(INC_STATUS).map(([k, l]) => `<option value="${k}" ${i.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label class="f">Investigation / follow-up<textarea name="followup">${esc(i.followup || '')}</textarea></label>` : ''}`,
      buttons: [{ label: 'Close', value: null }, ...(isManager(me) ? [{ label: 'Save', primary: true, value: w => formData(w) }] : [])] });
    if (v) { await store.update('incidents', i.id, v); toast('Saved'); ctx.reload(); }
  });
}
