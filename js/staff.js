// Staff register (people who work on site; most are not app users) and transport-rate defaults.
import { esc, fmt, money, dialog, formData, toast, confirmDlg, num, VEHICLES } from './util.js';
import { getSetting, setSetting } from './store.js';

export const STAFF_ROLES = ['Site Supervisor', 'Team leader', 'General worker', 'Horticulturist', 'Irrigation tech', 'Driver', 'Plant operator', 'Casual', 'Other'];

export async function editStaff(store, s) {
  const v = await dialog({
    title: s ? s.name : 'Add staff member',
    body: `<label class="f">Full name<input name="name" required value="${esc(s?.name)}"></label>
      <div class="grid2"><label class="f">Role<select name="role">${STAFF_ROLES.map(r => `<option ${s?.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
        <label class="f">Day rate (E)<input name="day_rate" inputmode="decimal" value="${s?.day_rate ?? ''}" placeholder="used for labour cost"></label></div>
      <div class="grid2"><label class="f">Phone / WhatsApp<input name="phone" type="tel" value="${esc(s?.phone)}" placeholder="+268 …"></label>
        <label class="f">App login email (supervisors)<input name="user_email" type="email" value="${esc(s?.user_email)}" placeholder="optional"></label></div>
      <label class="chk"><input type="checkbox" name="active" ${s?.active === false ? '' : 'checked'}> Currently working for Du Green</label>
      <label class="f">Notes<textarea name="notes">${esc(s?.notes)}</textarea></label>
      <p class="note">Supervisors with an app login see their daily plan and jobcards when they sign in. Add their email under Settings → Team with the Site Supervisor role.</p>`,
    buttons: [...(s ? [{ label: 'Delete', danger: true, value: 'delete' }] : []), { label: 'Cancel', value: null }, { label: 'Save', primary: true, value: w => formData(w), validate: w => !!w.querySelector('[name=name]').value.trim() }],
  });
  if (!v) return null;
  if (v === 'delete') { if (await confirmDlg('Delete staff member?', s.name)) { await store.remove('staff', s.id); return 'deleted'; } return null; }
  const row = { name: v.name.trim(), role: v.role, day_rate: num(v.day_rate), phone: v.phone || null, user_email: (v.user_email || '').trim().toLowerCase() || null, active: !!v.active, notes: v.notes || null };
  const out = s ? await store.update('staff', s.id, row) : await store.insert('staff', row);
  toast('Saved'); return out;
}

export async function render(app, ctx) {
  const { store } = ctx;
  const staff = await store.list('staff', {}, 'name');
  const active = staff.filter(s => s.active !== false);
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">People on site</div><h1>Staff register</h1>
      <p class="small muted" style="margin:4px 0 0">Supervisors pick from this list on the daily jobcard. Day rates feed labour cost in project reports.</p></div>
      <button class="btn primary" id="add">+ Add staff</button></div>
    <section class="card">${staff.length ? `<div class="tbl"><table><thead><tr><th>Name</th><th>Role</th><th>Phone</th><th class="n">Day rate</th><th>App login</th><th>Status</th></tr></thead><tbody>
      ${staff.map(s => `<tr class="click" data-s="${s.id}"><td><b>${esc(s.name)}</b></td><td>${esc(s.role || '')}</td><td class="small">${esc(s.phone || '')}</td><td class="n">${s.day_rate != null ? money(Number(s.day_rate)) : '–'}</td>
        <td class="small">${esc(s.user_email || '')}</td><td>${s.active === false ? '<span class="pill mute">Inactive</span>' : '<span class="pill ok">Active</span>'}</td></tr>`).join('')}
      </tbody></table></div><div class="small muted" style="padding:10px 14px">${active.length} active · daily wage bill ${money(active.reduce((t, s) => t + (Number(s.day_rate) || 0), 0))}</div>`
      : '<div class="empty"><b>No staff yet</b>Add your supervisors, team leaders and workers so they can be booked onto jobcards.</div>'}</section>
  </div>`;
  app.querySelector('#add').onclick = async () => { if (await editStaff(store, null)) ctx.reload(); };
  app.querySelectorAll('[data-s]').forEach(r => r.onclick = async () => { if (await editStaff(store, staff.find(s => s.id === r.dataset.s))) ctx.reload(); });
}

export async function renderVehicleSettings(el, store, canEdit) {
  const vs = await getSetting(store, 'vehicles', VEHICLES) || VEHICLES;
  el.innerHTML = `<div class="tbl"><table><thead><tr><th>Vehicle</th><th>Charged per</th><th class="n">Carries (m³)</th><th class="n">Default cost (E)</th></tr></thead><tbody>
    ${vs.map((v, i) => `<tr><td><input data-i="${i}" data-k="key" value="${esc(v.key)}" ${canEdit ? '' : 'disabled'}></td>
      <td><select data-i="${i}" data-k="basis" ${canEdit ? '' : 'disabled'}><option value="load" ${v.basis !== 'trip' ? 'selected' : ''}>Load</option><option value="trip" ${v.basis === 'trip' ? 'selected' : ''}>Trip</option></select></td>
      <td class="n"><input class="num" data-i="${i}" data-k="capacity_m3" inputmode="decimal" value="${v.capacity_m3 ?? ''}" ${canEdit ? '' : 'disabled'}></td>
      <td class="n"><input class="num" data-i="${i}" data-k="cost" inputmode="decimal" value="${v.cost ?? ''}" ${canEdit ? '' : 'disabled'}></td></tr>`).join('')}
    </tbody></table></div>
    ${canEdit ? '<div class="row" style="padding:10px 14px"><button class="btn small" id="vadd">+ Vehicle</button><span class="grow"></span><button class="btn small primary" id="vsave">Save transport rates</button></div>' : ''}`;
  if (!canEdit) return;
  const read = () => { const out = vs.map(v => ({ ...v })); el.querySelectorAll('[data-i]').forEach(i => { const o = out[+i.dataset.i]; o[i.dataset.k] = ['capacity_m3', 'cost'].includes(i.dataset.k) ? num(i.value) : i.value; }); return out.filter(v => v.key && v.key.trim()); };
  el.querySelector('#vadd').onclick = () => { vs.splice(0, vs.length, ...read(), { key: 'New vehicle', basis: 'load', capacity_m3: null, cost: null }); renderVehicleSettings(el, store, canEdit).then(() => {}); setSetting(store, 'vehicles', vs); };
  el.querySelector('#vsave').onclick = async () => { await setSetting(store, 'vehicles', read()); toast('Transport rates saved'); };
}
