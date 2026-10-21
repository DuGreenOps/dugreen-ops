// Contracts signed on site: Du Green's casual contracts (wording from the HR proformas), subcontract
// agreements defined per subbie in the app, and uploaded copies of other signed contracts.
import { esc, fmt, money, dialog, formData, toast, confirmDlg, num, today, fmtDate, uid, PERSON_KINDS, canSetRates } from './util.js';
import { CASUAL_FULL, CASUAL_SHORT } from './contract-texts.js';
import { captureSignature } from './sign.js';
import { getSetting } from './store.js';
import { head, open } from './docs.js';
import { CONFIG } from './config.js';
import { photoInput, wirePhoto, photoUrls, thumb } from './photos.js';

export const EWALLET_WARNING = 'Du Green Investments cannot be held responsible if the employee gives an incorrect or inactive EWallet number. Wages paid to a wrong or inactive number are the employee’s own responsibility and will only be re-sent once the funds are returned.';
export const WALLETS = ['FNB eWallet', 'MTN MoMo', 'Eswatini Mobile e-Mali', 'Other'];
const photoBlock = (P, who) => `${H('Photos')}<div class="row" style="gap:10px;align-items:flex-end">${[['idf', 'ID / passport – front'], ['idb', 'ID – back'], ['me', 'Photo of ' + who]].map(([k, l]) => `<div class="stack" style="gap:4px;align-items:flex-start"><span id="pv-${k}">${thumb(P[k], l, 84) || '<span style="display:inline-grid;place-items:center;width:84px;height:84px;border:1px dashed var(--line);border-radius:8px" class="small muted">none</span>'}</span>${photoInput('ph-' + k, '📷 ' + l)}</div>`).join('')}</div>`;

export const CONTRACT_TYPES = {
  casual_short: { label: 'Casual labour contract (as-and-when)', short: 'Casual (as-and-when)', kinds: ['casual', 'staff'], prefix: 'CL' },
  casual_full: { label: 'Project-based fixed-term contract', short: 'Fixed-term (project)', kinds: ['casual', 'staff'], prefix: 'FT' },
  subcontract: { label: 'Subcontract agreement', short: 'Subcontract', kinds: ['subcontractor'], prefix: 'SC' },
  upload: { label: 'Other signed contract (upload a copy)', short: 'Uploaded copy', kinds: ['staff', 'casual', 'subcontractor'], prefix: 'UP' },
};
export const SUB_BASIS = { lump_sum: 'Lump sum for the scope', measured: 'Measured rates (qty × rate)', day_rate: 'Day rate (per person-day)' };

export const DEFAULT_SUB_TERMS = `1. SCOPE AND STANDARD OF WORK
1.1 The Subcontractor shall carry out the Subcontract Works described in this agreement in a proper and workmanlike manner, to the specification, drawings and reasonable instructions of Du Green, and to the satisfaction of Du Green and its client.
1.2 The Subcontractor shall provide all labour, supervision, tools, small plant and PPE needed for the Subcontract Works unless this agreement states that Du Green supplies them.

2. PROGRAMME AND SITE RULES
2.1 The Subcontractor shall start and finish the works on the dates in this agreement and keep to Du Green's programme. Delays must be reported to the Du Green site supervisor in writing as soon as they are known.
2.2 The Subcontractor's workers must sign in on the Du Green daily jobcard each day they are on site, obey site rules, wear PPE and comply with the Occupational Safety and Health Act and Construction Regulations.

3. PRICE, CLAIMS AND PAYMENT
3.1 The Subcontract Sum or rates are as stated in this agreement, excluding VAT unless stated otherwise.
3.2 The Subcontractor shall submit a claim for work done up to the 25th of each month. Du Green will value the work actually done and accepted, and issue a payment certificate.
3.3 PAY-WHEN-PAID: Where this agreement says payment is pay-when-paid, amounts certified are payable within the number of days stated after Du Green has received payment from its client for the certificate that includes the Subcontract Works. Du Green is not obliged to pay any amount for which it has not been paid by the client.
3.4 Payment is made only to the bank account in this agreement. The Subcontractor is responsible for any delay caused by incorrect details.

4. RETENTION
4.1 Du Green shall retain the percentage of each certified amount stated in this agreement (normally 10%) until the total retention held reaches the cap stated (normally 5% of the Subcontract Sum).
4.2 Retention is released after the end of the defects liability period, once all defects notified have been made good.

5. VARIATIONS
5.1 No change to the scope, price or programme is valid unless instructed in writing by Du Green (a Site Instruction recorded in the Du Green app or signed on paper). Variations are valued at the agreement rates where they apply, otherwise at fair rates agreed in writing before the work is done.

6. MATERIALS, PLANT AND PROPERTY
6.1 Materials supplied by Du Green remain Du Green's property. The Subcontractor is responsible for their safekeeping once handed over and for any loss or waste beyond normal allowances, which may be deducted from payments.
6.2 Theft, damage or removal of any Du Green or client property will result in immediate termination and may be reported to the police.

7. LABOUR AND STATUTORY OBLIGATIONS
7.1 The Subcontractor is an independent contractor. Its workers are not employees of Du Green. The Subcontractor is solely responsible for their wages, statutory deductions and contributions, and compliance with the Employment Act and the Regulation of Wages (Building and Construction Industry) Order.

8. DEFECTS
8.1 The Subcontractor shall make good, at its own cost, any defects in the Subcontract Works that appear before the end of the defects liability period stated. If it does not do so within 7 days of notice, Du Green may have the work done by others and deduct the cost.

9. DELAY
9.1 Where a penalty for late completion is stated, Du Green may deduct that amount for each day the works remain incomplete after the completion date, unless an extension was granted in writing.

10. INSURANCE AND LIABILITY
10.1 The Subcontractor is responsible for injury to its workers and for loss or damage caused by its work or negligence, and indemnifies Du Green against claims arising from them.

11. TERMINATION
11.1 Du Green may terminate this agreement by written notice if the Subcontractor abandons the works, fails to make proper progress after 7 days' written notice, breaches safety rules seriously, or acts dishonestly. Du Green will then pay only for work properly done and accepted, less any costs of completing the works.

12. DISPUTES AND GOVERNING LAW
12.1 The parties shall first try to settle any dispute by meeting in good faith. This agreement is governed by the laws of the Kingdom of Eswatini.

13. ENTIRE AGREEMENT
13.1 This agreement, with any Site Instructions issued under it, is the whole agreement between the parties for the Subcontract Works.`;

// ------------------------------------------------------------------ status
export function contractState(c, on = today()) {
  if (!c) return 'none';
  if (c.status === 'void') return 'void';
  if (c.status !== 'signed') return 'draft';
  if (c.end_date && c.end_date < on) return 'expired';
  return 'signed';
}
// Best contract for a person on a project. Casual as-and-when and uploaded contracts can cover every project.
export function contractFor(personId, contracts, projectId, on = today()) {
  const mine = contracts.filter(c => c.person_id === personId && c.status !== 'void' && (!projectId || !c.project_id || c.project_id === projectId));
  const live = mine.filter(c => contractState(c, on) === 'signed');
  if (live.length) return { ok: true, state: 'signed', c: live.sort((a, b) => String(b.signed_at).localeCompare(String(a.signed_at)))[0] };
  const exp = mine.find(c => contractState(c, on) === 'expired'); if (exp) return { ok: false, state: 'expired', c: exp };
  const dr = mine.find(c => c.status === 'draft'); if (dr) return { ok: false, state: 'draft', c: dr };
  return { ok: false, state: 'none', c: null };
}
export const contractBadge = (r, compact = false) => r.state === 'signed' ? (compact ? `<span class="pill ok" title="${esc(CONTRACT_TYPES[r.c.type]?.short || '')}${r.c.end_date ? ' to ' + fmtDate(r.c.end_date) : ''}">✓ Signed</span>` : `<span class="pill ok">✓ ${esc(CONTRACT_TYPES[r.c.type]?.short || 'Contract')}${r.c.end_date ? ' to ' + fmtDate(r.c.end_date) : ''}</span>`)
  : r.state === 'expired' ? '<span class="pill bad">Contract expired</span>' : r.state === 'draft' ? '<span class="pill warn">Contract not signed</span>' : '<span class="pill bad">No contract</span>';

// ------------------------------------------------------------- the form
const F = (label, name, v, extra = '') => `<label class="f">${label}<input name="${name}" value="${esc(v ?? '')}" ${extra}></label>`;
const SEL = (label, name, opts, v) => `<label class="f">${label}<select name="${name}">${opts.map(o => { const [k, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(k)}" ${String(v ?? '') === String(k) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select></label>`;
const H = t => `<div class="cat-h" style="margin:14px 0 4px">${t}</div>`;

function employeeFields(d, rateLocked, P = {}) {
  return `${photoBlock(P, 'the employee')}${H('1. Employee details')}
    <div class="grid2">${F('Full name', 'full_name', d.full_name, 'required')}${F('ID / passport no.', 'id_no', d.id_no)}</div>
    <div class="grid3">${F('Nationality', 'nationality', d.nationality ?? 'Liswati')}${F('Date of birth', 'dob', d.dob, 'type="date"')}${SEL('Gender', 'gender', ['', 'Male', 'Female'], d.gender)}</div>
    ${F('Physical address', 'address', d.address)}
    <div class="grid2">${F('Cell / phone', 'phone', d.phone, 'type="tel"')}${F('Emergency contact (name)', 'em_name', d.em_name)}</div>
    <div class="grid2">${F('Emergency contact (relationship)', 'em_rel', d.em_rel)}${F('Emergency contact (phone)', 'em_phone', d.em_phone, 'type="tel"')}</div>
    ${H('2. Payment & banking')}
    <div class="grid2">${F('Bank', 'bank', d.bank)}${F('Account holder', 'acc_holder', d.acc_holder)}</div>
    <div class="grid3">${F('Account no.', 'acc_no', d.acc_no, 'inputmode="numeric"')}${F('Branch code', 'branch', d.branch, 'inputmode="numeric"')}${SEL('Account type', 'acc_type', ['', 'Cheque', 'Savings'], d.acc_type)}</div>
    ${SEL('Wages paid to', 'pay_method', [['bank', 'Bank account'], ['ewallet', 'EWallet / mobile money (phone number)']], d.pay_method || (d.ewallet ? 'ewallet' : 'bank'))}
    <div class="dims" data-ew><b style="font-family:var(--display)">EWallet payment number</b>
      <div class="grid3">${SEL('EWallet', 'ewallet_network', WALLETS, d.ewallet_network || 'FNB eWallet')}${F('EWallet phone number', 'ewallet', d.ewallet, 'type="tel" inputmode="tel" placeholder="e.g. 7612 3456"')}${F('Type the number again', 'ewallet2', d.ewallet2 ?? d.ewallet, 'type="tel" inputmode="tel"')}</div>
      <div class="note warn" style="margin:6px 0"><b>⚠ Warning:</b> ${esc(EWALLET_WARNING)}</div>
      <label class="chk"><input type="checkbox" name="ew_ack" ${d.ew_ack ? 'checked' : ''}> The employee has checked that this number is correct, registered in their name and active.</label></div>
    ${H('3. Project & role')}
    <div class="grid2">${F('Project / site', 'project_name', d.project_name)}${F('Site location', 'site', d.site)}</div>
    <div class="grid3">${F('Start date', 'start_date', d.start_date, 'type="date"')}${F('End date', 'end_date', d.end_date, 'type="date"')}${F('Supervisor / foreman', 'supervisor', d.supervisor)}</div>
    <div class="grid2">${F('Role / classification', 'role', d.role)}${F('Brief duties', 'duties', d.duties)}</div>
    ${H('4. Pay')}
    ${rateLocked ? `<p class="small ${d.daily_rate == null && d.monthly_rate == null ? 'flag' : 'muted'}">${d.daily_rate == null && d.monthly_rate == null ? 'No rate set yet. Ask Procurement or the QS to add it in the rates sheet before signing, or the contract will say the rate is per the Du Green rate schedule.' : 'Rates come from the rates sheet kept by Procurement and the QS.'}</p>` : ''}
    <div class="grid3">${SEL('Payment basis', 'pay_basis', [['day', 'Daily'], ['month', 'Monthly']], d.pay_basis || 'day')}${F('Daily rate (E)', 'daily_rate', d.daily_rate, `inputmode="decimal" ${rateLocked ? 'readonly' : ''}`)}${F('Monthly rate (E)', 'monthly_rate', d.monthly_rate, `inputmode="decimal" ${rateLocked ? 'readonly' : ''}`)}</div>
    <div class="grid3">${F('Saturday daily rate (E)', 'sat_rate', d.sat_rate, `inputmode="decimal" ${rateLocked ? 'readonly' : ''}`)}${F('Sunday daily rate (E)', 'sun_rate', d.sun_rate, `inputmode="decimal" ${rateLocked ? 'readonly' : ''}`)}${F('Public holiday rate (E)', 'ph_rate', d.ph_rate, `inputmode="decimal" ${rateLocked ? 'readonly' : ''}`)}</div>
    ${H('5. Working hours')}
    <div class="grid3">${F('Weekday start', 'wk_start', d.wk_start ?? '07:00', 'type="time"')}${F('Weekday end', 'wk_end', d.wk_end ?? '16:00', 'type="time"')}${F('Working days', 'wk_days', d.wk_days ?? 'Monday to Friday')}</div>
    <div class="grid3">${F('Saturday start', 'sat_start', d.sat_start ?? '07:00', 'type="time"')}${F('Saturday end', 'sat_end', d.sat_end ?? '12:00', 'type="time"')}${SEL('Saturday working', 'sat_type', ['Half day', 'Full day', 'Not applicable'], d.sat_type || 'Half day')}</div>
    ${F('Meal / rest break', 'break', d.break ?? '30 minutes unpaid')}`;
}

function subFields(d, areas, canRates, P = {}) {
  const lines = d.lines?.length ? d.lines : [{ description: '', unit: 'm²', qty: '', rate: '' }];
  return `${photoBlock(P, 'the contact person')}${H('Subcontractor')}
    <div class="grid2">${F('Company / trading name', 'company', d.company, 'required')}${F('Contact person (signs)', 'contact', d.contact)}</div>
    <div class="grid3">${F('Company reg. or ID no.', 'reg_no', d.reg_no)}${F('VAT no. (if registered)', 'vat_no', d.vat_no)}${F('Phone', 'phone', d.phone, 'type="tel"')}</div>
    <div class="grid2">${F('Email', 'email', d.email, 'type="email"')}${F('Address', 'address', d.address)}</div>
    <div class="grid2">${F('Bank', 'bank', d.bank)}${F('Account holder', 'acc_holder', d.acc_holder)}</div>
    <div class="grid2">${F('Account no.', 'acc_no', d.acc_no, 'inputmode="numeric"')}${F('Branch code', 'branch', d.branch, 'inputmode="numeric"')}</div>
    ${H('Subcontract works')}
    <label class="f">Scope of works<textarea name="scope" rows="3" placeholder="e.g. Supply and install paving to the courtyard (area H1) including bedding sand and edging">${esc(d.scope || '')}</textarea></label>
    ${areas.length ? `<div class="small muted" style="margin-top:6px">Areas covered</div><div class="row" style="gap:6px 14px">${areas.map(a => `<label class="chk"><input type="checkbox" name="area_ids" data-multi="1" value="${a.id}" ${(d.area_ids || []).includes(a.id) ? 'checked' : ''}> ${esc((a.code || '') + ' ' + (a.name || ''))}</label>`).join('')}</div>` : ''}
    <div class="grid3">${F('Start date', 'start_date', d.start_date, 'type="date"')}${F('Completion date', 'end_date', d.end_date, 'type="date"')}${F('Du Green site supervisor', 'supervisor', d.supervisor)}</div>
    ${H('Price')}
    ${SEL('How is the subbie paid?', 'basis', Object.entries(SUB_BASIS), d.basis || 'lump_sum')}
    <div data-sb="measured"><div class="tbl"><table><thead><tr><th>Item</th><th>Unit</th><th class="n">Qty</th><th class="n">Rate (E)</th></tr></thead><tbody id="sl">
      ${lines.map((l, i) => `<tr><td><input data-l="${i}" data-k="description" value="${esc(l.description)}"></td><td><input style="width:70px" data-l="${i}" data-k="unit" value="${esc(l.unit || '')}"></td><td class="n"><input class="num" style="width:80px" data-l="${i}" data-k="qty" inputmode="decimal" value="${l.qty ?? ''}"></td><td class="n"><input class="num" style="width:90px" data-l="${i}" data-k="rate" inputmode="decimal" value="${l.rate ?? ''}"></td></tr>`).join('')}
    </tbody></table></div><button class="btn small" type="button" id="addl">+ Line</button></div>
    <div data-sb="day_rate" class="grid3">${F('Day rate per person (E)', 'day_rate', d.day_rate, 'inputmode="decimal"')}${F('Crew size', 'crew', d.crew, 'inputmode="numeric"')}${F('Estimated days', 'est_days', d.est_days, 'inputmode="decimal"')}</div>
    <div class="grid2">${F('Subcontract sum excl. VAT (E)', 'contract_sum', d.contract_sum, 'inputmode="decimal"')}<div class="small muted" id="sumhint" style="align-self:end;padding-bottom:10px"></div></div>
    ${canRates ? '' : '<p class="small muted">Procurement and the QS can adjust the price later in the rates sheet.</p>'}
    ${H('Payment terms')}
    <div class="grid3">${F('Retention % of each payment', 'retention_pct', d.retention_pct ?? 10, 'inputmode="decimal"')}${F('Retention cap (% of sum)', 'retention_cap', d.retention_cap ?? 5, 'inputmode="decimal"')}${F('Defects period (days)', 'defects_days', d.defects_days ?? 90, 'inputmode="numeric"')}</div>
    <div class="grid3"><label class="chk" style="align-self:end;padding-bottom:10px"><input type="checkbox" name="pay_when_paid" ${d.pay_when_paid === false ? '' : 'checked'}> Pay-when-paid</label>${F('Pay within (days) after Du Green is paid', 'pay_days', d.pay_days ?? 7, 'inputmode="numeric"')}${F('Late penalty per day (E, optional)', 'penalty', d.penalty, 'inputmode="decimal"')}</div>
    <div class="grid2">${SEL('Materials supplied by', 'materials_by', ['Du Green', 'Subcontractor', 'As listed in the scope'], d.materials_by || 'Du Green')}${SEL('Tools, PPE & small plant by', 'tools_by', ['Subcontractor', 'Du Green'], d.tools_by || 'Subcontractor')}</div>
    <label class="f">Special conditions for this job<textarea name="special" rows="2" placeholder="Anything that differs from the standard terms">${esc(d.special || '')}</textarea></label>
    <details style="margin-top:8px"><summary class="small"><b>Standard terms</b> (edit for this subbie if needed)</summary><textarea name="conditions" rows="14" style="width:100%;font:12px/1.4 var(--body)">${esc(d.conditions || '')}</textarea></details>`;
}

// One dialog: pick type, fill details, then preview → sign. Returns the saved contract or null.
export async function startContract(ctx, { person, project = null, type = null, contract = null, areas = [] }) {
  const { store, me } = ctx;
  const canRates = canSetRates(me);
  const existing = contract;
  const kind = person.kind || 'staff';
  type = existing?.type || type || (kind === 'subcontractor' ? 'subcontract' : 'casual_short');
  const subTerms = await getSetting(store, 'subcontract_terms', DEFAULT_SUB_TERMS) || DEFAULT_SUB_TERMS;
  const supName = ctx.me?.full_name || '';
  let d = existing ? { ...existing.data } : {
    full_name: person.name, id_no: person.id_no, phone: person.phone, role: person.role, address: person.address,
    company: person.company || person.name, contact: person.contact || (person.company ? person.name : ''), email: person.email, reg_no: person.id_no,
    project_name: project?.name || '', site: project?.site_address || '', start_date: today(), supervisor: supName,
    pay_basis: person.pay_basis === 'month' ? 'month' : 'day',
    daily_rate: ['day'].includes(person.pay_basis) ? person.rate : null, monthly_rate: person.pay_basis === 'month' ? person.rate : null,
    basis: person.pay_basis === 'day' ? 'day_rate' : person.pay_basis === 'rate' ? 'measured' : 'lump_sum',
    day_rate: person.pay_basis === 'day' ? person.rate : null, contract_sum: person.pay_basis === 'job' ? person.rate : null, conditions: subTerms,
  };
  if (!d.conditions) d.conditions = subTerms;
  if (!canRates && type !== 'subcontract' && person.rate != null) { if (person.pay_basis === 'month') { d.pay_basis = 'month'; d.monthly_rate = person.rate; } else if (!person.pay_basis || person.pay_basis === 'day') { d.pay_basis = 'day'; d.daily_rate = person.rate; } }
  let filePath = existing?.file_path || null;
  const ph = { idf: existing?.id_photo || null, idb: existing?.id_photo_back || null, me: existing?.person_photo || person.photo || null };
  const P = await photoUrls(store, Object.values(ph)); const purl = { idf: P[ph.idf], idb: P[ph.idb], me: P[ph.me] };
  let idPhoto = ph.idf;
  const rateLocked = !canRates; // only Procurement, the QS and Matt set pay

  while (true) {
    const body = w => `<div class="row" style="gap:10px;align-items:flex-end">${SEL('Contract type', 'ctype', Object.entries(CONTRACT_TYPES).filter(([k, t]) => t.kinds.includes(kind) || k === existing?.type).map(([k, t]) => [k, t.label]), type)}
        <span class="small muted grow" style="padding-bottom:10px">For <b>${esc(person.name)}</b> · ${esc(PERSON_KINDS[kind] || kind)}${project ? ' · ' + esc(project.name) : ''}</span></div>
      <div id="cf">${formFor(type)}</div>`;
    const formFor = t => t === 'subcontract' ? subFields(d, areas, canRates, purl)
      : t === 'upload' ? `<p class="muted">Use this for permanent, probation and offer-of-employment contracts signed on paper. Photograph or scan the signed copy.</p>
          <div class="grid3">${F('Contract title', 'title', d.title || 'Contract of employment')}${F('Start date', 'start_date', d.start_date, 'type="date"')}${F('End date (blank if permanent)', 'end_date', d.end_date, 'type="date"')}</div>
          <div class="row"><label class="btn small">${filePath ? 'Replace signed copy' : 'Attach signed copy'}<input type="file" accept="image/*,application/pdf" capture="environment" id="up" hidden></label><span class="small muted" id="upm">${filePath ? 'Signed copy attached' : ''}</span></div>`
      : employeeFields(d, rateLocked, purl);
    const v = await dialog({
      title: existing ? `Contract ${existing.number}` : 'New contract', wide: true, sticky: true, body: body(),
      onOpen: w => {
        const wire = () => {
          const cf = w.querySelector('#cf');
          const sb = () => { const b = w.querySelector('[name=basis]')?.value; cf.querySelectorAll('[data-sb]').forEach(x => x.hidden = x.dataset.sb !== b); hint(); };
          const hint = () => {
            const b = w.querySelector('[name=basis]')?.value, h = w.querySelector('#sumhint'); if (!h) return;
            let s = null;
            if (b === 'measured') s = [...cf.querySelectorAll('[data-k=qty]')].reduce((t, q) => t + (num(q.value) || 0) * (num(q.closest('tr').querySelector('[data-k=rate]').value) || 0), 0);
            if (b === 'day_rate') s = (num(w.querySelector('[name=day_rate]').value) || 0) * (num(w.querySelector('[name=crew]').value) || 1) * (num(w.querySelector('[name=est_days]').value) || 0);
            h.textContent = s ? `Worked out: ${money(s)}${b === 'day_rate' ? ' (estimate)' : ''}` : '';
            if (s && !w.querySelector('[name=contract_sum]').dataset.touched) w.querySelector('[name=contract_sum]').value = s.toFixed(2);
          };
          for (const k of ['idf', 'idb', 'me']) wirePhoto(w, 'ph-' + k, store, 'hr', p => { ph[k] = p.path; purl[k] = p.url; if (k === 'idf') idPhoto = p.path; w.querySelector('#pv-' + k).innerHTML = thumb(p.url, k, 84); });
          const pm = w.querySelector('[name=pay_method]'), ew = w.querySelector('[data-ew]'); if (pm && ew) { const s = () => { ew.hidden = pm.value !== 'ewallet'; }; pm.onchange = s; s(); }
          w.querySelector('[name=contract_sum]')?.addEventListener('input', e => e.target.dataset.touched = 1);
          w.querySelector('[name=basis]') && (w.querySelector('[name=basis]').onchange = sb);
          cf.addEventListener('input', hint);
          w.querySelector('#addl') && (w.querySelector('#addl').onclick = () => { d = { ...d, ...readSub(w) }; d.lines.push({ description: '', unit: 'm²', qty: '', rate: '' }); cf.innerHTML = formFor('subcontract'); wire(); });
          w.querySelector('#up') && (w.querySelector('#up').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const path = `hr/contract-${uid()}.${(f.name.split('.').pop() || 'jpg').toLowerCase()}`; await store.upload('photos', path, f); filePath = path; w.querySelector('#upm').textContent = 'Signed copy attached'; } catch (err) { toast(err.message); } });
          sb();
        };
        w.querySelector('[name=ctype]').onchange = e => { d = { ...d, ...(type === 'subcontract' ? readSub(w) : formData(w.querySelector('#cf'))) }; type = e.target.value; w.querySelector('#cf').innerHTML = formFor(type); wire(); };
        wire();
      },
      buttons: [...(existing && existing.status !== 'signed' ? [{ label: 'Delete', danger: true, value: 'delete' }] : []), { label: 'Cancel', value: null },
        ...(type === 'upload' ? [] : [{ label: 'Save draft', value: w => ({ act: 'draft', data: type === 'subcontract' ? readSub(w) : formData(w.querySelector('#cf')) }) }]),
        { label: type === 'upload' ? 'Save' : 'Next: read & sign', primary: true, value: w => ({ act: 'next', data: type === 'subcontract' ? readSub(w) : formData(w.querySelector('#cf')), type: w.querySelector('[name=ctype]').value }),
          validate: w => { const n = w.querySelector('[name=full_name],[name=company]'); if (n && !n.value.trim()) { toast('Enter the name first'); return false; }
            const pm = w.querySelector('[name=pay_method]'); if (pm && pm.value === 'ewallet') { const a = w.querySelector('[name=ewallet]').value.replace(/\D/g, ''), b = w.querySelector('[name=ewallet2]').value.replace(/\D/g, ''); if (a.length < 8) { toast('Enter the full EWallet phone number'); return false; } if (a !== b) { toast('The two EWallet numbers do not match – check with the employee'); return false; } if (!w.querySelector('[name=ew_ack]').checked) { toast('Tick that the employee has checked the EWallet number'); return false; } } if (w.querySelector('[name=ctype]').value === 'upload' && !filePath) { toast('Attach the signed copy'); return false; } return true; } }],
    });
    if (!v) return null;
    if (v === 'delete') { if (await confirmDlg('Delete this draft contract?', existing.number)) { await store.remove('contracts', existing.id); return 'deleted'; } continue; }
    d = { ...d, ...v.data }; if (v.type) type = v.type;
    if (type === 'subcontract') d.area_names = areas.filter(a => (d.area_ids || []).includes(a.id)).map(a => `${a.code || ''} ${a.name || ''}`.trim()).join(', ');
    const row = { person_id: person.id, project_id: type === 'casual_short' || type === 'upload' ? (project?.id || null) : project?.id || null, type, start_date: d.start_date || null, end_date: d.end_date || null, data: d, file_path: filePath, id_photo: ph.idf, id_photo_back: ph.idb, person_photo: ph.me };
    if (v.act === 'draft') { const c = await saveContract(store, existing, { ...row, status: 'draft' }); toast('Draft saved'); return c; }
    if (type === 'upload') { const c = await saveContract(store, existing, { ...row, status: 'signed', signed_at: new Date().toISOString() }); await syncPerson(store, person, type, d); toast('Contract recorded'); return c; }

    // Preview and sign
    const draft = { ...(existing || {}), ...row, number: existing?.number || '(number on save)' };
    const who = type === 'subcontract' ? (d.contact || d.company) : d.full_name;
    const pv = await dialog({
      title: 'Read the contract with ' + who, wide: true, sticky: true,
      body: `<div class="cdoc">${contractHtml(draft, person, project)}</div>
        <div class="dims" style="margin-top:10px">
          <div class="grid2">${F('Signing for Du Green (name)', 'co_name', d.co_name || ctx.me?.full_name || d.supervisor || '')}${F('Designation', 'co_role', d.co_role || (ctx.me?.role === 'supervisor' ? 'Site Supervisor' : ''))}</div>
          <div class="grid2">${F('Witness name (optional)', 'witness', d.witness)}<div class="small ${ph.idf || type === 'subcontract' ? 'muted' : 'flag'}" style="align-self:end;padding-bottom:10px">${ph.idf ? '✓ ID photo taken' : type === 'subcontract' ? '' : 'No ID photo yet – go Back to take it. Pay can’t be processed without it.'}${ph.me ? ' · ✓ photo of person' : ''}</div></div>
          <label class="chk"><input type="checkbox" id="ack"> I have read and explained this contract to ${esc(who)} in a language they understand, and they had the chance to ask questions.</label></div>`,
      buttons: [{ label: 'Back', value: 'back' }, { label: 'Signatures', primary: true, value: w => ({ co_name: w.querySelector('[name=co_name]').value, co_role: w.querySelector('[name=co_role]').value, witness: w.querySelector('[name=witness]').value }), validate: w => { if (!w.querySelector('#ack').checked) { toast('Tick the box once the contract has been explained'); return false; } return true; } }],
    });
    if (pv === 'back') continue;
    if (!pv) return null;
    Object.assign(d, pv);
    const workerSign = await captureSignature(type === 'subcontract' ? 'Subcontractor signature' : 'Employee signature', who);
    if (!workerSign) { toast('The contract was not signed. It is saved as a draft.'); return await saveContract(store, existing, { ...row, data: d, id_photo: idPhoto, status: 'draft' }); }
    const coSign = await captureSignature('Signature for Du Green', d.co_name || '');
    if (!coSign) { toast('Du Green did not sign. Saved as a draft.'); return await saveContract(store, existing, { ...row, data: d, id_photo: idPhoto, status: 'draft' }); }
    const witnessSign = d.witness ? await captureSignature('Witness signature', d.witness) : null;
    const c = await saveContract(store, existing, { ...row, data: d, id_photo: idPhoto, status: 'signed', signed_at: new Date().toISOString(), worker_sign: workerSign, company_sign: coSign, witness_sign: witnessSign });
    await syncPerson(store, person, type, d, ph);
    toast(type !== 'subcontract' && !ph.idf ? 'Contract signed. ID copy still needed before pay.' : 'Contract signed');
    return c;
  }
}

function readSub(w) {
  const f = formData(w.querySelector('#cf'));
  const lines = []; w.querySelectorAll('#sl tr').forEach(tr => { const g = k => tr.querySelector(`[data-k=${k}]`).value; if (g('description').trim()) lines.push({ description: g('description').trim(), unit: g('unit'), qty: num(g('qty')), rate: num(g('rate')) }); });
  delete f.description; delete f.unit; delete f.qty; delete f.rate;
  return { ...f, lines, area_ids: f.area_ids || [], pay_when_paid: !!f.pay_when_paid, contract_sum: num(f.contract_sum), day_rate: num(f.day_rate), crew: num(f.crew), est_days: num(f.est_days), retention_pct: num(f.retention_pct), retention_cap: num(f.retention_cap), pay_days: num(f.pay_days), defects_days: num(f.defects_days), penalty: num(f.penalty) };
}

async function saveContract(store, existing, row) {
  if (existing?.id) return await store.update('contracts', existing.id, row);
  const all = await store.list('contracts', {}, null);
  const yr = new Date().getFullYear(), pre = `DG-${CONTRACT_TYPES[row.type].prefix}-${yr}-`;
  const n = all.filter(c => String(c.number || '').startsWith(pre)).length + 1;
  return await store.insert('contracts', { ...row, number: pre + String(n).padStart(3, '0') });
}

// Keep the register in step with what was captured on the contract.
async function syncPerson(store, person, type, d, ph = {}) {
  const patch = {};
  if (ph.me) patch.photo = ph.me;
  if (type !== 'subcontract') Object.assign(patch, { pay_method: d.pay_method || 'bank', ewallet_network: d.pay_method === 'ewallet' ? d.ewallet_network : null, ewallet_no: d.pay_method === 'ewallet' ? d.ewallet : null, bank: d.bank || null, acc_no: d.acc_no || null, branch: d.branch || null, acc_holder: d.acc_holder || null });
  else Object.assign(patch, { bank: d.bank || null, acc_no: d.acc_no || null, branch: d.branch || null, acc_holder: d.acc_holder || null });
  if (type === 'subcontract') { if (d.company) patch.company = d.company; if (d.phone) patch.phone = d.phone; if (d.email) patch.email = d.email; if (d.reg_no) patch.id_no = d.reg_no; }
  else { if (d.id_no) patch.id_no = d.id_no; if (d.phone) patch.phone = d.phone; if (d.address) patch.address = d.address; if (d.role && !person.role) patch.role = d.role; }
  if (Object.keys(patch).length) await store.update('staff', person.id, patch);
}

// ------------------------------------------------------------ the document
const kv = rows => `<table class="kv"><tbody>${rows.map(r => `<tr>${r.map(([l, v]) => `<td class="k">${esc(l)}</td><td>${esc(v ?? '') || '&nbsp;'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const sec = t => `<h3 class="sec">${esc(t)}</h3>`;
const rateTxt = v => v != null && v !== '' ? 'E ' + fmt(Number(v), 2) : 'As per the Du Green rate schedule for this classification';

export function contractHtml(c, person, project) {
  const d = c.data || {};
  const t = c.type;
  if (t === 'subcontract') return subHtml(c, d, project);
  if (t === 'upload') return `<h2 class="ct">${esc(d.title || 'Contract')}</h2><p>Signed paper copy on file${c.file_path ? '' : ' (missing)'}. ${d.start_date ? 'From ' + fmtDate(d.start_date) : ''}${d.end_date ? ' to ' + fmtDate(d.end_date) : ''}</p>`;
  const T = t === 'casual_full' ? CASUAL_FULL : CASUAL_SHORT;
  const details = [
    sec(t === 'casual_full' ? 'SECTION 1 — EMPLOYEE PERSONAL DETAILS' : '1. EMPLOYEE DETAILS'),
    kv([[['Full name', d.full_name], ['ID / passport no.', d.id_no]], [['Nationality', d.nationality], ['Date of birth', d.dob ? fmtDate(d.dob) : '']], [['Gender', d.gender], ['Cell / phone', d.phone]], [['Physical address', d.address], ['Emergency contact', [d.em_name, d.em_rel, d.em_phone].filter(Boolean).join(' · ')]]]),
    sec(t === 'casual_full' ? 'SECTION 2 — PAYMENT & BANKING DETAILS' : '3. PAYMENT & BANKING DETAILS'),
    kv([[['Wages paid to', d.pay_method === 'ewallet' ? 'EWallet / mobile money' : 'Bank account'], ['', '']], [['Bank', d.bank], ['Account type', d.acc_type]], [['Account holder', d.acc_holder], ['Account no.', d.acc_no]], [['Branch code', d.branch], ['EWallet', d.pay_method === 'ewallet' ? `${d.ewallet_network || ''} ${d.ewallet || ''}`.trim() : d.ewallet]]]),
    `<p class="note-b"><b>⚠ EWALLET WARNING:</b> ${esc(EWALLET_WARNING)}${d.pay_method === 'ewallet' && d.ew_ack ? ' The employee confirmed the number above is correct and active.' : ''}</p>`,
    '<p class="sm">The Company is NOT liable for payments sent to an incorrect EWallet or bank account number supplied by the Employee. Incorrect payment details are the Employee\'s sole responsibility.</p>',
    sec(t === 'casual_full' ? 'SECTION 3 — PROJECT, CONTRACT DETAILS & ROLE' : '2. PROJECT & SITE DETAILS'),
    kv([[['Project / site', d.project_name], ['Site location', d.site]], [['Start date', d.start_date ? fmtDate(d.start_date) : ''], ['End date', d.end_date ? fmtDate(d.end_date) : '']], [['Supervisor / foreman', d.supervisor], ['Role / classification', d.role]], [['Duties', d.duties], ['', '']]]),
  ];
  const pay = kv([[['Payment basis', d.pay_basis === 'month' ? 'Monthly' : 'Daily'], [d.pay_basis === 'month' ? 'Monthly rate' : 'Daily rate (Mon–Fri)', d.pay_basis === 'month' ? rateTxt(d.monthly_rate) : rateTxt(d.daily_rate)]], [['Saturday', d.sat_rate ? rateTxt(d.sat_rate) : 'As per the Regulation of Wages Order'], ['Sunday / public holiday', [d.sun_rate && rateTxt(d.sun_rate), d.ph_rate && rateTxt(d.ph_rate)].filter(Boolean).join(' / ') || 'As per the Regulation of Wages Order']]]);
  const hours = kv([[['Weekdays', `${d.wk_start || ''} – ${d.wk_end || ''} · ${d.wk_days || ''}`], ['Saturday', `${d.sat_type || ''}${d.sat_type !== 'Not applicable' ? ` · ${d.sat_start || ''} – ${d.sat_end || ''}` : ''}`]], [['Meal / rest break', d.break], ['', '']]]);
  // details = [emp hdr, emp, bank hdr, bank, ewallet warning, liability note, project hdr, project]
  if (t !== 'casual_full') details.splice(0, details.length, details[0], details[1], details[6], details[7], details[2], details[3], details[4], details[5]); // short form: employee, project, banking
  let body = '';
  if (t === 'casual_full') {
    body = T.intro.map(p => `<p>${esc(p)}</p>`).join('') + details.join('');
    for (const b of T.clauses) {
      if (b.p && /SCHEDULE \(/.test(b.p)) continue;
      if (b.h) { body += sec(b.h); if (b.h.startsWith('SECTION 4')) body += pay; if (b.h.startsWith('SECTION 5')) body += hours; }
      else if (b.h2) body += `<h4>${esc(b.h2)}</h4>`;
      else if (b.note) body += `<p class="note-b">${esc(b.note)}</p>`;
      else body += `<p>${esc(b.p)}</p>`;
    }
  } else {
    body = T.intro.map(p => `<p>${esc(p)}</p>`).join('') + details.join('') + `<p class="sm">${esc(T.notes[0] || '')}</p>`
      + sec('4. REMUNERATION — RATES & WORKING HOURS') + pay + hours + `<p class="sm">${esc(T.notes[1] || '')}</p>` + sec('5. KEY TERMS & CONDITIONS');
    for (const b of T.clauses) body += b.h2 ? `<h4>${esc(b.h2)}</h4>` : b.p && /^\d+\.\d+\.\d+/.test(b.p) ? `<p>${esc(b.p)}</p>` : b.p ? `<h4>${esc(b.p)}</h4>` : b.note ? `<p class="note-b">${esc(b.note)}</p>` : '';
    if (!T.clauses.some(b => b.note && /ACKNOWLEDGEMENT/.test(b.note))) body += (T.ack || []).map(a => `<p class="note-b">${esc(a)}</p>`).join('');
  }
  return `<h2 class="ct">${esc(T.title)}</h2><div class="cst">${esc(T.subtitle)}</div><div class="cno">Contract no. ${esc(c.number || '')}</div>${body}${sigBlock(c, d, 'FOR THE EMPLOYER', 'FOR THE EMPLOYEE', d.full_name, `ID No: ${d.id_no || ''}`)}`;
}

function subHtml(c, d, project) {
  const basisRows = d.basis === 'measured' ? `<table><thead><tr><th>Item</th><th>Unit</th><th class="n">Qty</th><th class="n">Rate (E)</th><th class="n">Amount (E)</th></tr></thead><tbody>${(d.lines || []).map(l => `<tr><td>${esc(l.description)}</td><td>${esc(l.unit || '')}</td><td class="n">${fmt(l.qty, 2)}</td><td class="n">${fmt(l.rate, 2)}</td><td class="n">${fmt((Number(l.qty) || 0) * (Number(l.rate) || 0), 2)}</td></tr>`).join('')}</tbody></table>`
    : d.basis === 'day_rate' ? kv([[['Day rate per person', rateTxt(d.day_rate)], ['Crew size', d.crew]], [['Estimated days', d.est_days], ['', '']]]) + '<p class="sm">Days are counted from the Du Green daily jobcards signed by the site supervisor.</p>' : '';
  return `<h2 class="ct">SUBCONTRACT AGREEMENT</h2><div class="cst">${esc(project?.name || d.project_name || '')}</div><div class="cno">Agreement no. ${esc(c.number || '')}</div>
    <p>This agreement is entered into between <b>${esc(CONFIG.COMPANY.name)}</b> ("Du Green") and the Subcontractor below for the Subcontract Works described.</p>
    ${sec('1. THE SUBCONTRACTOR')}${kv([[['Company / trading name', d.company], ['Contact person', d.contact]], [['Reg. / ID no.', d.reg_no], ['VAT no.', d.vat_no]], [['Phone', d.phone], ['Email', d.email]], [['Address', d.address], ['', '']], [['Bank', d.bank], ['Account holder', d.acc_holder]], [['Account no.', d.acc_no], ['Branch code', d.branch]]])}
    ${sec('2. SUBCONTRACT WORKS')}<p style="white-space:pre-wrap">${esc(d.scope || '')}</p>${d.area_names ? `<p class="sm">Areas: ${esc(d.area_names)}</p>` : ''}
    ${kv([[['Start date', d.start_date ? fmtDate(d.start_date) : ''], ['Completion date', d.end_date ? fmtDate(d.end_date) : '']], [['Du Green site supervisor', d.supervisor], ['Materials supplied by', d.materials_by]], [['Tools, PPE & small plant by', d.tools_by], ['', '']]])}
    ${sec('3. PRICE')}<p><b>${esc(SUB_BASIS[d.basis] || '')}</b> · Subcontract sum ${d.contract_sum != null ? '<b>' + money(Number(d.contract_sum)) + '</b>' : 'to be measured'} excluding VAT.</p>${basisRows}
    ${sec('4. PAYMENT TERMS')}${kv([[['Retention', `${fmt(d.retention_pct ?? 10, 1)}% of each payment, capped at ${fmt(d.retention_cap ?? 5, 1)}% of the sum`], ['Defects liability period', `${d.defects_days ?? 90} days after completion`]], [['Payment', d.pay_when_paid === false ? `Within ${d.pay_days ?? 7} days of certification` : `Pay-when-paid: within ${d.pay_days ?? 7} days after Du Green is paid by the client`], ['Late completion penalty', d.penalty ? money(Number(d.penalty)) + ' per day' : 'None']]])}
    ${d.special ? sec('5. SPECIAL CONDITIONS') + `<p style="white-space:pre-wrap">${esc(d.special)}</p>` : ''}
    ${sec((d.special ? '6' : '5') + '. STANDARD TERMS')}<div style="white-space:pre-wrap" class="terms">${esc(d.conditions || '')}</div>
    ${sigBlock(c, d, 'FOR DU GREEN', 'FOR THE SUBCONTRACTOR', d.contact || d.company, d.company)}`;
}

function sigBlock(c, d, l1, l2, name2, sub2) {
  const img = s => s ? `<img src="${s}" alt="Signature" style="height:56px;display:block">` : '<div style="height:56px"></div>';
  return `<table class="sigs"><tbody><tr><td><b>${l1}</b>${img(c.company_sign)}<div class="ln">Name: ${esc(d.co_name || '')}</div><div>Designation: ${esc(d.co_role || '')}</div><div>Date: ${c.signed_at ? fmtDate(c.signed_at) : ''}</div></td>
    <td><b>${l2}</b>${img(c.worker_sign)}<div class="ln">Name: ${esc(name2 || '')}</div><div>${esc(sub2 || '')}</div><div>Date: ${c.signed_at ? fmtDate(c.signed_at) : ''}</div></td></tr>
    <tr><td colspan="2"><b>WITNESS</b>${img(c.witness_sign)}<div class="ln">Name / date: ${esc(d.witness || '')}${d.witness && c.signed_at ? ' · ' + fmtDate(c.signed_at) : ''}</div></td></tr></tbody></table>
    ${c.signed_at ? `<p class="sm">Signed electronically on site in the Du Green Ops app on ${new Date(c.signed_at).toLocaleString('en-GB')}.</p>` : ''}`;
}

const DOC_CSS = `<style>.ct{font-size:17px;margin:6px 0 2px;text-align:center}.cst{text-align:center;font-size:12px;color:#444}.cno{text-align:center;font-size:12px;margin-bottom:10px}
  h3.sec{background:#E8EFE2;font-size:12px;letter-spacing:.04em;padding:5px 8px;margin:14px 0 6px}h4{font-size:12.5px;margin:10px 0 3px}p{font-size:12px;margin:4px 0}.sm{font-size:11px;color:#444}
  .note-b{border:1px solid #ccc;padding:6px 8px;font-size:11.5px}table.kv td{font-size:12px;padding:4px 6px;border:1px solid #ddd}table.kv td.k{background:#f6f6f6;width:18%;font-weight:bold}
  .terms{font-size:11.5px;line-height:1.45}table.sigs{margin-top:18px}table.sigs td{width:50%;border:0;padding:8px 10px 14px 0;font-size:12px}.ln{border-top:1px solid #333;padding-top:3px}</style>`;

export async function openContractDoc(c, person, project, store = null) {
  const U = store ? await photoUrls(store, [c.id_photo, c.id_photo_back, c.person_photo]) : {};
  let ppe = [];
  if (store && (c.type === 'casual_short' || c.type === 'casual_full')) { try { const St = await import('./stores.js'); const S = await St.loadStores(store); ppe = S.moves.filter(m => m.to_loc === 'person:' + c.person_id && m.type === 'receive_site' && S.itemBy[m.item_id]?.kind === 'ppe').map(m => ({ name: S.itemBy[m.item_id]?.name || '', date: m.move_date, value: S.itemBy[m.item_id]?.unit_cost, qty: m.qty, tag: S.assetBy[m.asset_id]?.tag_no })); } catch (e) { } }
  const ids = [[c.person_photo, 'Photo of ' + (c.type === 'subcontract' ? 'contact person' : 'employee')], [c.id_photo, 'ID / passport – front'], [c.id_photo_back, 'ID – back']].filter(([p]) => p && U[p]);
  open(`${head(CONTRACT_TYPES[c.type]?.label || 'Contract', `<div style="font-size:13px">${esc(person?.name || '')}${project ? ' · ' + esc(project.name) : ''}</div>`)}${DOC_CSS}${contractHtml(c, person, project)}
    ${ids.length ? `<div style="page-break-before:always"></div><h3 class="sec">ANNEXURE — IDENTIFICATION</h3><div style="display:flex;gap:14px;flex-wrap:wrap">${ids.map(([p, l]) => `<figure style="margin:0"><img src="${U[p]}" alt="${esc(l)}" style="max-width:320px;max-height:240px;border:1px solid #ccc"><figcaption style="font-size:11px">${esc(l)}</figcaption></figure>`).join('')}</div>` : ''}
    ${c.type === 'casual_short' || c.type === 'casual_full' ? `<div style="page-break-before:always"></div><h3 class="sec">ANNEXURE — PPE ISSUE LOG</h3><p class="sm">Completed each time PPE is issued — the employee signs per item at the time of issue.</p>
      <table><thead><tr><th>#</th><th>PPE item</th><th>Date issued</th><th>Value (E)</th><th>Employee signature</th><th>Issuing officer</th><th>Date returned</th><th>Condition</th></tr></thead><tbody>
      ${ppe.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.name)}${x.tag ? ' ' + esc(x.tag) : ''}${x.qty > 1 ? ' × ' + fmt(x.qty) : ''}</td><td>${fmtDate(x.date)}</td><td>${x.value != null ? fmt(x.value * (x.qty || 1), 2) : ''}</td><td>(signed in app)</td><td>Central Stores</td><td></td><td></td></tr>`).join('')}
      ${(ppe.length ? ['', '', '', '', ''] : ['Safety helmet / hard hat', 'Hi-vis vest', 'Safety boots', 'Work gloves', 'Protective eyewear', 'Dust mask / respirator', 'Ear protection', 'Reflective jacket', 'Overalls / work suit', 'Safety harness', '', '', '']).map((x, i) => `<tr><td>${ppe.length + i + 1}</td><td style="height:24px">${x}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`).join('')}</tbody></table>` : ''}`, c.number || 'Contract');
}

// View one contract in the app (with print / continue signing).
export async function viewContract(ctx, c, person, project) {
  const st = contractState(c);
  const U = await photoUrls(ctx.store, [c.id_photo, c.id_photo_back, c.person_photo]); const idUrl = U[c.id_photo];
  let fileUrl = null; if (c.file_path) try { fileUrl = await ctx.store.fileUrl('photos', c.file_path); } catch (e) { }
  const v = await dialog({
    title: `${c.number} · ${CONTRACT_TYPES[c.type]?.short || ''}`, wide: true,
    body: `<div class="row">${st === 'signed' ? '<span class="pill ok">Signed</span>' : st === 'expired' ? '<span class="pill bad">Expired</span>' : st === 'void' ? '<span class="pill mute">Cancelled</span>' : '<span class="pill warn">Draft – not signed</span>'}
        ${c.signed_at ? `<span class="small muted">Signed ${new Date(c.signed_at).toLocaleString('en-GB')}</span>` : ''}${fileUrl ? `<a class="btn small" href="${fileUrl}" target="_blank" rel="noopener">Open signed copy</a>` : ''}${idUrl ? `<a class="btn small" href="${idUrl}" target="_blank" rel="noopener">ID copy</a>` : (c.type === 'casual_short' || c.type === 'casual_full') && st === 'signed' ? '<span class="pill warn">ID copy outstanding</span>' : ''}</div>
      <div class="row" style="gap:8px;margin:8px 0">${[[c.person_photo, 'Person'], [c.id_photo, 'ID front'], [c.id_photo_back, 'ID back']].filter(([p]) => U[p]).map(([p, l]) => `<a href="${U[p]}" target="_blank" rel="noopener" title="${l}">${thumb(U[p], l, 72)}</a>`).join('')}</div>
      <div class="cdoc">${contractHtml(c, person, project)}</div>`,
    buttons: [...(st === 'signed' && canSetRates(ctx.me) ? [{ label: 'Cancel contract', danger: true, value: 'void' }] : []), { label: 'Print / PDF', value: 'print' }, ...(st === 'draft' ? [{ label: 'Continue & sign', primary: true, value: 'sign' }] : [{ label: 'Close', primary: true, value: null }])],
  });
  if (v === 'print') openContractDoc(c, person, project, ctx.store);
  if (v === 'sign') return await startContract(ctx, { person, project, contract: c });
  if (v === 'void' && await confirmDlg('Cancel this contract?', 'It stays on record but no longer counts as a contract in place.', 'Cancel contract')) { await ctx.store.update('contracts', c.id, { status: 'void' }); toast('Contract cancelled'); return 'void'; }
  return null;
}
