// "Ask Claude" panel: questions about the current project, answered with the project's data as context.
import { esc, dialog, fmt } from './util.js';
import { areaMeasures } from './geo.js';
import { loadProcurement } from './procure.js';

export async function projectSnapshot(store, project) {
  const D = await loadProcurement(store, project);
  return {
    project: { name: project.name, client: project.client, code: project.code, site: project.site_address, status: project.status, vat_rate: project.vat_rate },
    areas: D.areas.map(a => { const m = areaMeasures(a); return { code: a.code, name: a.name, type: a.type, area_m2: m.area && +m.area.toFixed(1), length_m: m.length && +m.length.toFixed(1), count: m.count, notes: a.notes }; }),
    items: D.items.map(i => ({ item: i.description, spec: i.spec, unit: i.unit, qty: +i.qty.toFixed(2), category: i.category, selected_supplier: D.sup[D.selBy[i.item_key]?.supplier_id]?.name || null, unit_cost: D.selBy[i.item_key]?.unit_price ?? null, on_po: D.onPo.has(i.item_key) })),
    rfqs: D.rfqs.map(r => ({ number: r.number, title: r.title, status: r.status, suppliers: (r.supplier_ids || []).map(s => D.sup[s]?.name), quotes: D.quotes.filter(q => q.rfq_id === r.id).map(q => D.sup[q.supplier_id]?.name) })),
    purchase_orders: D.pos.map(p => ({ number: p.number, supplier: D.sup[p.supplier_id]?.name, status: p.status, lines: D.poLines.filter(l => l.po_id === p.id).length })),
  };
}

export async function openClaude(ctx) {
  const { store, project } = ctx;
  const history = [];
  let snap = null;
  const render = w => {
    w.querySelector('.chat').innerHTML = history.length ? history.map(m => `<div class="msg ${m.role === 'user' ? 'me' : ''}">${esc(m.content)}</div>`).join('')
      : `<p class="muted">Ask about this project, for example:</p>
         <div class="stack" style="gap:6px">${['Which items still have no price, and who could supply them?', 'Summarise the scope by area for the client.', 'Check the spec: is anything missing for a new garden bed install?', 'Draft a covering email for RFQ to nurseries.'].map(q => `<button class="btn small" style="justify-content:flex-start;white-space:normal;text-align:left" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
    w.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { w.querySelector('#cq').value = b.dataset.q; ask(w); });
    const box = w.querySelector('.dlg-body'); box.scrollTop = box.scrollHeight;
  };
  const ask = async w => {
    const inp = w.querySelector('#cq'), q = inp.value.trim(); if (!q) return;
    inp.value = ''; history.push({ role: 'user', content: q }); history.push({ role: 'assistant', content: 'Thinking…' }); render(w);
    try {
      snap = snap || await projectSnapshot(store, project);
      const r = await store.claude('ask', { question: q, history: history.slice(0, -2).slice(-8), context: snap, project_id: project.id });
      history[history.length - 1].content = r.answer || '(no answer)';
    } catch (e) { history[history.length - 1].content = 'Claude is not available: ' + e.message; }
    render(w);
  };
  await dialog({
    title: '✦ Ask Claude about this project', wide: true,
    body: `<div class="chat"></div>
      <div class="row" style="position:sticky;bottom:0;background:var(--surface);padding-top:6px"><input id="cq" class="grow" placeholder="Ask anything about ${esc(project.name)}…" style="flex:1"><button class="btn primary" id="cs">Ask</button></div>
      <p class="small muted">Claude sees this project's areas, specification, prices, RFQs and POs. Check its answers before acting on them.</p>`,
    onOpen: w => { render(w); w.querySelector('#cs').onclick = () => ask(w); w.querySelector('#cq').onkeydown = e => { if (e.key === 'Enter') ask(w); }; },
    buttons: [{ label: 'Close', value: null }],
  });
}
