// Router, sign-in, projects home, project shell, settings and team.
import { makeStore, serverConfig } from './store.js';
import { esc, fmt, money, dialog, formData, toast, confirmDlg, ROLES, fmtDate, num } from './util.js';
import { areaMeasures } from './geo.js';
import * as Areas from './areas.js';
import * as MapView from './map.js';
import * as Spec from './spec.js';
import * as Procure from './procure.js';
import * as Costing from './costing.js';
import * as Library from './library.js';
import * as Pow from './pow.js';
import * as Site from './site.js';
import * as Costs from './costs.js';
import * as Staff from './staff.js';
import * as Dashboard from './dashboard.js';
import * as Certs from './certs.js';
import * as Reports from './reports.js';
import { journey } from './journey.js';
import { renderVehicleSettings, renderSubTermsSettings } from './staff.js';
import { getSetting, setSetting } from './store.js';
import { openClaude } from './claude.js';

const store = makeStore();
const app = document.getElementById('app');
let me = null;
let cleanup = null;

export const ctx = { store, get me() { return me; }, go, reload: route, newProject: () => editProject() };
window.__dg = ctx; // handy for debugging

function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function setNav(key) { document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === key)); }

function banner() {
  const b = document.getElementById('banner');
  if (store.mode === 'demo') {
    b.innerHTML = `<div class="banner"><b>Demo mode.</b> Data is saved only in this browser. ${serverConfig() ? '' : 'Connect the shared server in <a href="#/settings">Settings</a> to work as a team and use Claude.'}</div>`;
  } else b.innerHTML = '';
}

function whoBox() {
  const el = document.getElementById('who');
  el.innerHTML = me ? `<b>${esc(me.full_name || me.email)}</b>${esc(ROLES[me.role] || me.role)}${store.mode === 'demo' ? ' · demo' : ''}` : '';
}

async function route() {
  if (cleanup) { try { cleanup(); } catch (e) { } cleanup = null; }
  document.querySelector('.fab')?.remove();
  const hash = location.hash || '#/';
  const parts = hash.split('?')[0].replace(/^#\/?/, '').split('/').filter(Boolean);

  // Password recovery link from email
  if (/type=recovery/.test(location.hash)) return renderRecovery();

  if (store.mode === 'cloud') {
    const s = await store.session();
    if (!s) { setNav(''); whoBox(); return renderAuth(); }
    me = await store.me(true);
    whoBox();
    if (!me || me.role === 'pending') return renderPending();
  } else { me = await store.me(); whoBox(); }
  banner();

  try {
    if (parts[0] === 'p' && parts[1]) return await renderProject(parts[1], parts[2] || (me?.role === 'supervisor' ? 'site' : 'areas'), parts.slice(3));
    if (parts[0] === 'projects') { setNav('projects'); return await renderHome(); }
    if (parts[0] === 'staff' || parts[0] === 'people') { setNav('staff'); return await Staff.render(app, ctx, parts.slice(1)); }
    if (parts[0] === 'library') { setNav('library'); return await Library.render(app, ctx, parts.slice(1)); }
    if (parts[0] === 'settings') { setNav('settings'); return await renderSettings(); }
    setNav('home'); return await Dashboard.render(app, ctx);
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="page"><div class="card"><div class="bd"><h2>Something went wrong</h2><p class="muted">${esc(e.message || e)}</p><button class="btn" onclick="location.reload()">Reload</button></div></div></div>`;
  }
}

// ------------------------------------------------------------------ auth
function renderAuth(mode = 'in') {
  app.innerHTML = `<div class="auth"><div class="card">
    <img src="icons/logo.png" alt="Du Green Organic">
    <h1 style="text-align:center;font-size:26px">${mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create your account' : 'Reset password'}</h1>
    <form id="af" class="stack">
      ${mode === 'up' ? '<label class="f">Full name<input name="name" autocomplete="name" required></label>' : ''}
      <label class="f">Email<input name="email" type="email" autocomplete="email" required></label>
      ${mode !== 'reset' ? `<label class="f">Password<input name="pw" type="password" autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}" minlength="8" required></label>` : ''}
      <button class="btn primary" type="submit">${mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create account' : 'Email me a reset link'}</button>
      <p class="small muted" id="amsg" role="status"></p>
    </form>
    <div class="row small" style="justify-content:space-between">
      ${mode === 'in' ? '<a href="#" data-m="up">New here? Create an account</a><a href="#" data-m="reset">Forgot password</a>' : '<a href="#" data-m="in">Back to sign in</a>'}
    </div>
    <p class="note">Use the email address Matt added to the team. Accounts for other addresses wait for approval.</p>
  </div></div>`;
  app.querySelectorAll('[data-m]').forEach(a => a.onclick = e => { e.preventDefault(); renderAuth(a.dataset.m); });
  app.querySelector('#af').onsubmit = async e => {
    e.preventDefault();
    const f = formData(e.target), msg = app.querySelector('#amsg');
    msg.textContent = 'Working…';
    try {
      if (mode === 'in') { await store.signIn(f.email, f.pw); route(); }
      else if (mode === 'up') {
        const r = await store.signUp(f.email, f.pw, f.name);
        if (r.session) route(); else msg.textContent = 'Check your email to confirm your address, then sign in.';
      } else { await store.resetPassword(f.email); msg.textContent = 'If that address has an account, a reset link is on its way.'; }
    } catch (err) { msg.textContent = err.message; }
  };
}
function renderRecovery() {
  app.innerHTML = `<div class="auth"><div class="card"><h1 style="font-size:24px">Choose a new password</h1>
    <form id="rf" class="stack"><label class="f">New password<input name="pw" type="password" minlength="8" required autocomplete="new-password"></label>
    <button class="btn primary">Save password</button><p id="rmsg" class="small muted"></p></form></div></div>`;
  app.querySelector('#rf').onsubmit = async e => {
    e.preventDefault();
    try { await store.updatePassword(formData(e.target).pw); location.hash = '#/'; toast('Password saved'); }
    catch (err) { app.querySelector('#rmsg').textContent = err.message; }
  };
}
function renderPending() {
  app.innerHTML = `<div class="auth"><div class="card"><img src="icons/logo.png" alt=""><h1 style="font-size:24px;text-align:center">Waiting for access</h1>
    <p>You're signed in as <b>${esc(me?.email)}</b>, but this address isn't on the Du Green team list yet.</p>
    <p class="muted">Ask Matt to add you under Settings → Team, then reload this page.</p>
    <div class="row"><button class="btn" onclick="location.reload()">Reload</button><button class="btn" id="so">Sign out</button></div></div></div>`;
  app.querySelector('#so').onclick = async () => { await store.signOut(); route(); };
}

// ------------------------------------------------------------------ home
async function renderHome() {
  const [projects, areas] = await Promise.all([store.list('projects', {}, 'created_at'), store.list('areas', {}, null)]);
  projects.reverse();
  const byP = {}; areas.forEach(a => (byP[a.project_id] = byP[a.project_id] || []).push(a));
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Installation projects</div><h1>Projects</h1></div>
      <div class="row"><button class="btn primary" id="np">+ New installation project</button></div></div>
    ${projects.length ? `<div class="plist">${projects.map(p => {
      const as = byP[p.id] || []; const m2 = as.reduce((t, a) => t + (areaMeasures(a).area || 0), 0);
      return `<a class="card pcard" href="#/p/${p.id}/areas">
        <div class="row"><span class="pill ${p.status === 'active' ? 'ok' : p.status === 'complete' ? 'mute' : 'info'}">${esc(statusLabel(p.status))}</span>${p.code ? `<span class="small muted">${esc(p.code)}</span>` : ''}</div>
        <h3>${esc(p.name)}</h3>
        <div class="small muted">${esc(p.client || 'No client set')}${p.site_address ? ' · ' + esc(p.site_address) : ''}</div>
        <div class="small"><b>${as.length}</b> areas · <b>${fmt(m2)}</b> m²</div></a>`;
    }).join('')}</div>` : `<div class="card empty"><b>No projects yet</b>Start one for the office test site: tap “New installation project”, then open the map on site.</div>`}
  </div>`;
  app.querySelector('#np').onclick = () => editProject();
}
const STATUSES = [['tender', 'Tender / RFQ'], ['awarded', 'Awarded'], ['active', 'Installing'], ['handover', 'Handover'], ['complete', 'Complete']];
const statusLabel = s => (STATUSES.find(x => x[0] === s) || [s, s])[1];

async function editProject(p) {
  const v = await dialog({
    title: p ? 'Project details' : 'New installation project',
    body: `<label class="f">Project name<input name="name" required value="${esc(p?.name)}" placeholder="e.g. Du Green Office test site"></label>
      <div class="grid2"><label class="f">Client<input name="client" value="${esc(p?.client)}"></label>
      <label class="f">Reference<input name="code" value="${esc(p?.code)}" placeholder="DGI-2026-..."></label></div>
      <label class="f">Site address / description<input name="site_address" value="${esc(p?.site_address)}"></label>
      <div class="grid2"><label class="f">Status<select name="status">${STATUSES.map(([k, l]) => `<option value="${k}" ${p?.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f">VAT rate %<input name="vat" inputmode="decimal" value="${p ? fmt((p.vat_rate ?? 0.15) * 100, 1) : '15'}"></label></div>
      <label class="f">Notes<textarea name="notes">${esc(p?.notes)}</textarea></label>
      ${p ? '' : '<p class="note">The site location is set the first time you open the map on site (it uses your phone’s GPS), or you can add areas by hand without a map.</p>'}`,
    buttons: [...(p ? [{ label: 'Delete project', danger: true, value: 'delete' }] : []), { label: 'Cancel', value: null }, { label: p ? 'Save' : 'Create project', primary: true, value: w => formData(w), validate: w => w.querySelector('[name=name]').value.trim() !== '' }],
  });
  if (!v) return;
  if (v === 'delete') {
    if (await confirmDlg('Delete project?', `This removes ${p.name} and all its areas, specs, RFQs, quotes and POs.`)) { await store.remove('projects', p.id); go('#/'); }
    return;
  }
  const row = { name: v.name.trim(), client: v.client, code: v.code, site_address: v.site_address, status: v.status, notes: v.notes, vat_rate: (num(v.vat) ?? 15) / 100 };
  if (p) { await store.update('projects', p.id, row); route(); }
  else { const np = await store.insert('projects', { ...row, kind: 'installation' }); go(`#/p/${np.id}/areas`); }
}

// --------------------------------------------------------------- project
const TABS = [['areas', 'Areas'], ['map', 'Map'], ['spec', 'Specification'], ['pow', 'Programme'], ['procure', 'Procurement'], ['costing', 'Costing & BOQ'], ['site', 'Site diary'], ['certs', 'Certificates'], ['reports', 'Reports & costs']];
async function renderProject(id, tab, rest) {
  setNav('projects');
  if (tab === 'costs') { tab = 'reports'; rest = ['costs']; }
  const project = await store.get('projects', id);
  if (!project) { app.innerHTML = `<div class="page"><div class="card empty"><b>Project not found</b><a href="#/">Back to projects</a></div></div>`; return; }
  const pctx = Object.assign(Object.create(ctx), { project, tab, rest, editProject: () => editProject(project) });
  app.innerHTML = `<div class="phead ${tab === 'map' ? 'compact' : ''}"><div class="in">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div class="grow"><div class="eyebrow"><a href="#/" style="text-decoration:none">Projects</a> · ${esc(statusLabel(project.status))}</div>
          <h1>${esc(project.name)}</h1>
          <div class="meta">${project.client ? `<span>${esc(project.client)}</span>` : ''}${project.code ? `<span>${esc(project.code)}</span>` : ''}${project.site_address ? `<span>${esc(project.site_address)}</span>` : ''}</div></div>
        <button class="btn small" id="pedit">Details</button></div>
      <div id="journey"></div>
      <nav class="tabs" aria-label="Project sections">${TABS.map(([k, l]) => `<a href="#/p/${id}/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</nav>
    </div></div><div id="pbody"></div>`;
  app.querySelector('#pedit').onclick = () => editProject(project);
  const body = app.querySelector('#pbody');
  const view = { areas: Areas, map: MapView, spec: Spec, procure: Procure, costing: Costing, pow: Pow, site: Site, certs: Certs, reports: Reports }[tab] || Areas;
  if (tab !== 'map') journey(app.querySelector('#journey'), pctx).catch(e => console.warn('journey', e));
  const c = await view.render(body, pctx);
  if (typeof c === 'function') cleanup = c;
  if (tab !== 'map') {
    const fab = document.createElement('button');
    fab.className = 'fab'; fab.innerHTML = '<span class="spark">✦</span> Ask Claude';
    fab.onclick = () => openClaude(pctx);
    document.body.append(fab);
  }
}

// -------------------------------------------------------------- settings
async function renderSettings() {
  const cfg = serverConfig();
  let team = [];
  if (store.mode === 'cloud') { try { team = await store.list('team', {}, 'email'); } catch (e) { } }
  const isAdmin = me?.role === 'admin';
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">App</div><h1>Settings</h1></div></div>
    <section class="card"><div class="hd"><h2>Your account</h2></div><div class="bd stack">
      <div>${esc(me?.full_name || '')} <span class="muted">${esc(me?.email || '')}</span> · <b>${esc(ROLES[me?.role] || me?.role)}</b></div>
      ${store.mode === 'cloud' ? '<div><button class="btn" id="so">Sign out</button></div>' : `<label class="f" style="max-width:280px">Try the app as<select id="drole">${Object.entries(ROLES).filter(([k]) => k !== 'pending').map(([k, l]) => `<option value="${k}" ${me?.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`}
    </div></section>
    ${store.mode === 'cloud' ? `<section class="card"><div class="hd"><h2>Team</h2><span class="muted small">People listed here can sign in with their own email and password.</span>
      ${isAdmin ? '<span class="grow"></span><button class="btn small primary" id="addm">+ Add person</button>' : ''}</div>
      <div class="tbl"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th>${isAdmin ? '<th></th>' : ''}</tr></thead><tbody>
      ${team.map(t => `<tr><td>${esc(t.full_name)}</td><td>${esc(t.email)}</td><td>${esc(ROLES[t.role] || t.role)}</td>${isAdmin ? `<td class="n"><button class="btn small" data-edit="${esc(t.email)}">Edit</button></td>` : ''}</tr>`).join('')}
      </tbody></table></div></section>` : ''}
    <section class="card"><div class="hd"><h2>Transport rates</h2><span class="small muted">Defaults offered when the QS adds a transport line</span></div><div id="vset"></div>
      <div class="bd row"><label class="f" style="max-width:240px">Casual worker day rate (E)<input id="crate" inputmode="decimal" ${isAdmin || store.mode === 'demo' ? '' : 'disabled'}></label><span class="small muted">Used for unnamed casual workers on older jobcards. Named people are costed from the rates sheet.</span></div></section>
    <section class="card"><div class="hd"><h2>Standard subcontract terms</h2></div><div id="sterms"></div></section>
    <section class="card"><div class="hd"><h2>Server</h2><span class="pill ${store.mode === 'cloud' ? 'ok' : 'warn'}">${store.mode === 'cloud' ? 'Connected' : 'Demo mode'}</span></div><div class="bd stack">
      <p class="small muted">The shared server (Supabase) stores the team's data and files and runs Claude for the app. Your administrator sets this up once.</p>
      <div class="grid2"><label class="f">Server URL<input id="surl" value="${esc(cfg?.url || '')}" placeholder="https://xxxx.supabase.co"></label>
      <label class="f">Public (anon) key<input id="skey" value="${esc(cfg?.key || '')}"></label></div>
      <div class="row"><button class="btn primary" id="ssave">Save and connect</button>
        ${store.mode === 'cloud' ? '<button class="btn" id="sdemo">Use demo mode on this device</button>' : localStorage.getItem('dg-force-demo') ? '<button class="btn" id="scloud">Leave demo mode</button>' : ''}</div>
    </div></section>
    ${store.mode === 'demo' ? `<section class="card"><div class="hd"><h2>Demo data</h2></div><div class="bd row">
      <button class="btn danger" id="dclear">Clear all demo data</button></div></section>` : ''}
    <p class="small muted">Du Green Ops · version 1.0 · Satellite imagery: Esri World Imagery · Street map: © OpenStreetMap contributors</p>
  </div>`;
  const $ = s => app.querySelector(s);
  renderVehicleSettings(app.querySelector('#vset'), store, isAdmin || store.mode === 'demo');
  renderSubTermsSettings(app.querySelector('#sterms'), store, ['admin', 'qs'].includes(me?.role) || store.mode === 'demo');
  getSetting(store, 'casual_day_rate', null).then(v => { $('#crate').value = v ?? ''; });
  $('#crate').onchange = async e => { await setSetting(store, 'casual_day_rate', num(e.target.value)); toast('Casual day rate saved'); };
  $('#so') && ($('#so').onclick = async () => { await store.signOut(); location.hash = '#/'; location.reload(); });
  $('#drole') && ($('#drole').onchange = e => { localStorage.setItem('dg-demo-role', e.target.value); route(); });
  $('#ssave').onclick = () => {
    const url = $('#surl').value.trim(), key = $('#skey').value.trim();
    if (!/^https:\/\/.+/.test(url) || key.length < 20) return toast('Enter the server URL and anon key from Supabase → Project settings → API.');
    localStorage.setItem('dg-server', JSON.stringify({ url, key })); localStorage.removeItem('dg-force-demo'); location.hash = '#/'; location.reload();
  };
  $('#sdemo') && ($('#sdemo').onclick = () => { localStorage.setItem('dg-force-demo', '1'); location.reload(); });
  $('#scloud') && ($('#scloud').onclick = () => { localStorage.removeItem('dg-force-demo'); location.reload(); });
  $('#dclear') && ($('#dclear').onclick = async () => { if (await confirmDlg('Clear demo data?', 'Deletes every demo project, supplier and price on this device.', 'Clear')) { localStorage.removeItem('dg-demo-db'); indexedDB.deleteDatabase('dg-demo-files'); location.reload(); } });
  const editMember = async t => {
    const v = await dialog({
      title: t ? 'Edit team member' : 'Add team member',
      body: `<label class="f">Full name<input name="full_name" value="${esc(t?.full_name)}"></label>
        <label class="f">Email<input name="email" type="email" ${t ? 'readonly' : ''} value="${esc(t?.email)}" required></label>
        <label class="f">Role<select name="role">${Object.entries(ROLES).filter(([k]) => k !== 'pending').map(([k, l]) => `<option value="${k}" ${t?.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <p class="note">They create their own account on the sign-in page using this email.</p>`,
      buttons: [...(t ? [{ label: 'Remove', danger: true, value: 'del' }] : []), { label: 'Cancel', value: null }, { label: 'Save', primary: true, value: w => formData(w) }],
    });
    if (!v) return;
    try {
      if (v === 'del') { await store.sb.from('team').delete().eq('email', t.email); await store.sb.from('profiles').update({ role: 'pending' }).eq('email', t.email); }
      else await store.upsert('team', { email: v.email.trim().toLowerCase(), full_name: v.full_name, role: v.role }, 'email');
      route();
    } catch (e) { toast(e.message); }
  };
  $('#addm') && ($('#addm').onclick = () => editMember());
  app.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editMember(team.find(t => t.email === b.dataset.edit)));
}

window.addEventListener('hashchange', route);
if (store.mode === 'cloud') store.sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') route(); if (ev === 'PASSWORD_RECOVERY') renderRecovery(); });
route();
