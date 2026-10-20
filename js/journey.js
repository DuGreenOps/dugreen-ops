// The project journey: one strip across the top of every project page that shows where the job is,
// from measuring the site to handover, and what to do next.
import { esc, addDays, today } from './util.js';
import { contractFor } from './contracts.js';

export async function journey(el, ctx) {
  if (!el) return;
  const { store, project } = ctx;
  const P = { project_id: project.id };
  const [areas, spec, costing, tasks, pos, jobcards, claims, handovers, contracts, subCerts] = await Promise.all([
    store.list('areas', P, null), store.list('spec_items', P, null), store.list('costing', P, null), store.list('tasks', P, null), store.list('purchase_orders', P, null),
    store.list('jobcards', P, 'card_date'), store.list('claims', P, null), store.list('handovers', P, null), store.list('contracts', {}, null), store.list('sub_certs', P, null)]);
  const keys = [...new Set(spec.map(s => s.item_key))];
  const marked = new Set(costing.filter(c => c.markup_pct != null || c.sell_override != null).map(c => c.item_key));
  const since = addDays(today(), -30);
  const onSite = new Set(); for (const j of jobcards.filter(j => j.card_date >= since)) { for (const s of j.staff || []) if (s.staff_id) onSite.add(s.staff_id); for (const s of j.subbies || []) onSite.add(s.person_id); }
  const noContract = [...onSite].filter(id => !contractFor(id, contracts, project.id).ok).length;
  const toReview = jobcards.filter(j => j.status === 'submitted').length, submitted = jobcards.filter(j => j.status !== 'draft').length;
  const done = tasks.length && tasks.every(t => t.status === 'done');
  const h = handovers[0];
  const base = `#/p/${project.id}/`;
  const steps = [
    { k: 'areas', l: 'Measure', ok: areas.length > 0, note: areas.length ? `${areas.length} areas` : 'Add areas' },
    { k: 'spec', l: 'Specify', ok: keys.length > 0, note: keys.length ? `${keys.length} items` : 'Add items' },
    { k: 'costing', l: 'Price', ok: keys.length > 0 && keys.every(k => marked.has(k)), note: keys.length ? `${keys.filter(k => !marked.has(k)).length || 'all'} ${keys.every(k => marked.has(k)) ? 'marked up' : 'need mark-up'}` : '–' },
    { k: 'pow', l: 'Programme', ok: tasks.length > 0, note: tasks.length ? `${tasks.length} tasks` : 'Plan the work' },
    { k: 'procure', l: 'Buy', ok: pos.length > 0 && !pos.some(p => ['draft', 'pending', 'rejected'].includes(p.status)), note: pos.length ? `${pos.filter(p => p.status === 'pending').length ? pos.filter(p => p.status === 'pending').length + ' to approve' : pos.length + ' POs'}` : 'No POs yet' },
    { k: 'site', l: 'Build', ok: submitted > 0 && !toReview && !noContract && done, warn: noContract > 0 || toReview > 0, note: noContract ? `${noContract} without contract` : toReview ? `${toReview} jobcards to review` : submitted ? `${submitted} jobcards` : 'No jobcards yet' },
    { k: 'certs', l: 'Certify', ok: claims.length > 0 && !subCerts.some(s => s.status === 'draft'), note: claims.length ? `${claims.length} IPCs` : 'No certificates' },
    { k: 'reports/handover', l: 'Hand over', ok: h?.status === 'signed', note: h?.status === 'signed' ? 'Signed' : h ? 'Draft' : done ? 'Ready' : '–' },
  ];
  const next = steps.find(s => !s.ok);
  el.innerHTML = `<div class="journey" role="list" aria-label="Project journey">${steps.map((s, i) => `<a role="listitem" href="${base}${s.k}" class="js ${s.ok ? 'ok' : s.warn ? 'warn' : ''} ${s === next ? 'next' : ''}" title="${esc(s.note)}"><span class="jn">${s.ok ? '✓' : s.warn ? '!' : i + 1}</span><span class="jl">${s.l}<small>${esc(s.note)}</small></span></a>`).join('')}</div>`;
}
