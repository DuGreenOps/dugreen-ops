// Areas / zones: list, add by hand (no map) with dimensions, edit map-traced areas
// (side overrides, area mode), site photos, KML import and export to the Areas tab.
import { esc, fmt, dialog, formData, toast, confirmDlg, num, AREA_TYPES, typeColor, copyText, byNatural, uid } from './util.js';
import { areaMeasures, SHAPES, shapeMeasures } from './geo.js';
import { importKml } from './kml.js';

export function nextCode(areas, type) {
  const prefix = (AREA_TYPES.find(t => t.key === type) || AREA_TYPES[0]).prefix;
  let max = 0;
  areas.forEach(a => { const m = String(a.code || '').match(new RegExp('^' + prefix + '(\\d+)', 'i')); if (m) max = Math.max(max, +m[1]); });
  return prefix + (max + 1);
}

export function measureText(a) {
  const m = areaMeasures(a);
  const parts = [];
  if (m.area != null && m.area > 0) parts.push(`${fmt(m.area, 1)} m²`);
  if (m.length) parts.push(`${fmt(m.length, 1)} m`);
  if (m.count) parts.push(`${fmt(m.count)} no.`);
  return parts.join(' · ') || 'No dimensions yet';
}

export function sortAreas(areas) { return [...areas].sort((a, b) => (a.sort || 0) - (b.sort || 0) || byNatural(a.code, b.code)); }

export async function render(root, ctx) {
  const { store, project } = ctx;
  const [areas, items] = await Promise.all([store.list('areas', { project_id: project.id }), store.list('spec_items', { project_id: project.id }, null)]);
  const list = sortAreas(areas);
  let tA = 0, tL = 0, tC = 0;
  list.forEach(a => { const m = areaMeasures(a); tA += m.area || 0; tL += m.length || 0; tC += m.count || 0; });
  const nItems = id => items.filter(i => i.area_id === id).length;
  root.innerHTML = `<div class="page">
    <div class="kpis">
      <div class="kpi"><div class="k">Areas / zones</div><div class="v">${list.length}</div></div>
      <div class="kpi"><div class="k">Total area</div><div class="v">${fmt(tA, 1)} m²</div></div>
      <div class="kpi"><div class="k">Linear runs</div><div class="v">${fmt(tL, 1)} m</div></div>
      <div class="kpi"><div class="k">Spec lines</div><div class="v">${items.length}</div></div>
    </div>
    <section class="card">
      <div class="hd"><h2>Areas and zones</h2><span class="grow"></span>
        <button class="btn" id="kml" title="Import outlines traced in Google Earth">Import Google Earth</button>
        <button class="btn" id="copy" ${list.length ? '' : 'disabled'}>Copy for Areas tab</button>
        <a class="btn" href="#/p/${project.id}/map">Open map</a>
        <button class="btn primary" id="add">+ Add area</button></div>
      ${list.length ? `<div class="alist">${list.map(a => `
        <div class="arow" data-id="${a.id}" tabindex="0" role="button">
          <span class="code" style="background:${typeColor(a.type)}">${esc(a.code || '—')}</span>
          <div style="min-width:0"><div class="t">${esc(a.name || a.type || 'Area')}</div>
            <div class="m">${esc(a.type || '')} · ${a.source === 'map' ? 'traced on map' : a.source === 'kml' ? 'from Google Earth' : 'measured by hand'}${nItems(a.id) ? ` · ${nItems(a.id)} spec lines` : ''}${(a.photos || []).length ? ` · ${(a.photos || []).length} photos` : ''}${areaMeasures(a).anyMeasured ? ' · sides measured' : ''}</div></div>
          <div class="v">${measureText(a)}</div>
        </div>`).join('')}</div>`
      : `<div class="empty"><b>No areas yet</b>Add one by hand with its measurements, or open the map and trace it on site. Traced areas appear here automatically.</div>`}
    </section>
  </div>`;
  const $ = s => root.querySelector(s);
  $('#add').onclick = async () => { if (await editArea(ctx, null, { areas: list })) ctx.reload(); };
  root.querySelectorAll('.arow').forEach(r => {
    const open = async () => { if (await editArea(ctx, list.find(a => a.id === r.dataset.id), { areas: list })) ctx.reload(); };
    r.onclick = open; r.onkeydown = e => { if (e.key === 'Enter') open(); };
  });
  $('#copy').onclick = async () => {
    const rows = list.map(a => { const m = areaMeasures(a); return [a.code, a.name, a.type, m.area != null ? +m.area.toFixed(2) : '', m.length ? +m.length.toFixed(2) : '', (a.notes || '').replace(/\s+/g, ' '), a.id].join('\t'); });
    (await copyText(rows.join('\n'))) ? toast(`Copied ${rows.length} areas. Paste into cell A6 of the Areas tab.`) : toast('Copy failed on this device.');
  };
  $('#kml').onclick = () => importKml(ctx, list);
}

// ------------------------------------------------------------ area editor
// Used from the Areas list and from the map. Returns the saved row, 'deleted', or null.
export async function editArea(ctx, area, { areas = [], geom = null, focusEdge = null } = {}) {
  const { store, project } = ctx;
  const isMap = !!(geom || area?.geom);
  const g = geom || area?.geom;
  const draft = {
    ...(area || {}), geom: g,
    type: area?.type || 'Garden',
    edges: area?.edges ? JSON.parse(JSON.stringify(area.edges)) : null,
    shape: area?.shape ? JSON.parse(JSON.stringify(area.shape)) : { kind: g ? null : 'rect' },
    area_mode: area?.area_mode || null, area_override: area?.area_override ?? null,
    photos: [...(area?.photos || [])],
  };
  if (!area) draft.code = nextCode(areas, draft.type);
  const photoUrls = {};

  const body = () => {
    const m = areaMeasures(draft);
    return `
    <div class="grid3">
      <label class="f">Code<input name="code" value="${esc(draft.code)}" placeholder="G1"></label>
      <label class="f span2">Name<input name="name" value="${esc(draft.name)}" placeholder="e.g. Entrance flowerbed"></label>
    </div>
    <label class="f">Type<select name="type">${AREA_TYPES.map(t => `<option ${draft.type === t.key ? 'selected' : ''}>${t.key}</option>`).join('')}</select></label>
    ${isMap ? mapDims(m) : manualDims(m)}
    <label class="f">Scope notes<textarea name="notes" placeholder="What happens here: strip, level, plant, irrigate…">${esc(draft.notes)}</textarea></label>
    <div class="stack"><div class="row"><b style="font-family:var(--display)">Site photos</b><span class="grow"></span>
      <label class="btn small">Add photo<input type="file" accept="image/*" capture="environment" id="ph" hidden multiple></label></div>
      <div class="row" id="phs">${draft.photos.map((p, i) => `<img data-ph="${i}" alt="Site photo ${i + 1}" style="width:84px;height:84px;object-fit:cover;border-radius:8px;border:1px solid var(--line)" src="${photoUrls[p.path] || ''}">`).join('') || '<span class="small muted">No photos yet.</span>'}</div></div>`;
  };

  const mapDims = m => `<div class="dims">
      <div class="row"><b style="font-family:var(--display)">${m.kind === 'polygon' ? 'Sides (traced on map)' : m.kind === 'line' ? 'Run (traced on map)' : 'Points'}</b><span class="grow"></span><span class="small muted">Type your tape measurement to override a side</span></div>
      ${m.edges.length ? `<div class="tbl"><table><thead><tr><th>Side</th><th class="n">Traced</th><th class="n">Measured (m)</th></tr></thead><tbody>
        ${m.edges.map((e, i) => `<tr><td>${i + 1}</td><td class="n">${fmt(e.traced, 2)} m</td><td class="n"><input class="num" data-edge="${i}" inputmode="decimal" value="${e.measured ?? ''}" placeholder="—" aria-label="Measured length of side ${i + 1}"></td></tr>`).join('')}
      </tbody></table></div>` : ''}
      ${m.kind === 'polygon' ? `<div class="stack" style="gap:6px">
        <label class="chk"><input type="radio" name="amode" value="traced" ${m.mode === 'traced' ? 'checked' : ''}> Traced area: <b>${fmt(m.tracedArea, 2)} m²</b></label>
        <label class="chk"><input type="radio" name="amode" value="scaled" ${m.mode === 'scaled' ? 'checked' : ''} ${m.anyMeasured ? '' : 'disabled'}> Adjusted to measured sides: <b>${fmt(m.scaledArea, 2)} m²</b></label>
        <label class="chk"><input type="radio" name="amode" value="manual" ${m.mode === 'manual' ? 'checked' : ''}> Use my own area: <input name="aover" inputmode="decimal" style="width:110px" value="${draft.area_override ?? ''}"> m²</label>
      </div>` : ''}
      <div class="result" id="res">${resultText(m)}</div></div>`;

  const manualDims = m => {
    const s = draft.shape || { kind: 'rect' };
    const def = SHAPES[s.kind] || SHAPES.rect;
    let fields = '';
    if (s.kind === 'rects') {
      const rows = s.rows?.length ? s.rows : [{ l: '', w: '' }];
      fields = `<div class="stack" style="gap:6px">${rows.map((r, i) => `<div class="row"><input data-r="${i}" data-k="l" inputmode="decimal" placeholder="Length" value="${r.l ?? ''}" style="width:100px"> × <input data-r="${i}" data-k="w" inputmode="decimal" placeholder="Width" value="${r.w ?? ''}" style="width:100px">
        <label class="chk small"><input type="checkbox" data-r="${i}" data-k="minus" ${r.minus ? 'checked' : ''}> subtract</label></div>`).join('')}
        <div><button class="btn small" type="button" id="addr">+ Rectangle</button></div></div>`;
    } else if (s.kind === 'sides') {
      const sides = s.sides?.length ? s.sides : ['', '', ''];
      fields = `<div class="row">${sides.map((v, i) => `<input data-side="${i}" inputmode="decimal" placeholder="Side ${i + 1}" value="${v}" style="width:88px">`).join('')}<button class="btn small" type="button" id="adds">+ Side</button></div>
        <label class="f">Area (m²)<input data-k="area" inputmode="decimal" value="${s.area ?? ''}"></label>`;
    } else {
      fields = `<div class="grid2">${def.fields.map(([k, l]) => `<label class="f">${l}<input data-k="${k}" inputmode="decimal" value="${s[k] ?? ''}"></label>`).join('')}</div>`;
    }
    return `<div class="dims">
      <label class="f">Dimensions<select id="shape">${Object.entries(SHAPES).map(([k, d]) => `<option value="${k}" ${s.kind === k ? 'selected' : ''}>${d.label}</option>`).join('')}</select></label>
      ${fields}
      ${!['linear', 'count'].includes(s.kind) ? `<label class="chk small"><input type="checkbox" id="ovr" ${draft.area_mode === 'manual' ? 'checked' : ''}> Override area: <input name="aover" inputmode="decimal" style="width:110px" value="${draft.area_override ?? ''}"> m²</label>` : ''}
      <div class="result" id="res">${resultText(m)}</div></div>`;
  };

  const resultText = m => {
    const p = [];
    if (m.area != null) p.push(`Area <b>${fmt(m.area, 2)} m²</b>`);
    if (m.perimeter) p.push(`Perimeter ${fmt(m.perimeter, 2)} m`);
    if (m.length) p.push(`Length <b>${fmt(m.length, 2)} m</b>`);
    if (m.count) p.push(`Count <b>${fmt(m.count)}</b>`);
    return p.join(' · ') || '<span class="muted">Enter dimensions</span>';
  };

  let wrapRef = null;
  const readInto = w => {
    const f = formData(w);
    draft.code = f.code; draft.name = f.name; draft.type = f.type; draft.notes = f.notes;
    if (isMap) {
      const m = areaMeasures(draft);
      draft.edges = m.edges.map((e, i) => { const inp = w.querySelector(`[data-edge="${i}"]`); return { measured: inp ? num(inp.value) : e.measured }; });
      const am = w.querySelector('[name=amode]:checked'); const auto = draft.edges.some(e => e.measured != null) ? 'scaled' : 'traced'; draft.area_mode = am && am.value !== auto ? am.value : null;
      draft.area_override = num(f.aover);
    } else {
      const s = draft.shape;
      if (s.kind === 'rects') {
        const rows = [];
        w.querySelectorAll('[data-r]').forEach(el => { const i = +el.dataset.r; rows[i] = rows[i] || {}; rows[i][el.dataset.k] = el.type === 'checkbox' ? el.checked : num(el.value); });
        s.rows = rows;
      } else if (s.kind === 'sides') {
        s.sides = [...w.querySelectorAll('[data-side]')].map(el => num(el.value) ?? '');
        const a = w.querySelector('[data-k=area]'); s.area = a ? num(a.value) : null;
      } else w.querySelectorAll('.dims [data-k]').forEach(el => { s[el.dataset.k] = num(el.value); });
      const ovr = w.querySelector('#ovr');
      draft.area_mode = ovr && ovr.checked ? 'manual' : null;
      draft.area_override = num(f.aover);
    }
  };
  const rerender = (read = true) => { if (read) readInto(wrapRef); wrapRef.querySelector('.dlg-body').innerHTML = body(); wire(wrapRef); };
  const live = () => { readInto(wrapRef); const r = wrapRef.querySelector('#res'); if (r) r.innerHTML = resultText(areaMeasures(draft)); };
  const wire = w => {
    w.querySelectorAll('.dims input').forEach(el => el.addEventListener('input', live));
    w.querySelectorAll('[name=amode]').forEach(el => el.addEventListener('change', live));
    const sh = w.querySelector('#shape'); if (sh) sh.onchange = () => { readInto(w); draft.shape = { kind: sh.value }; draft.area_mode = null; w.querySelector('.dlg-body').innerHTML = body(); wire(w); };
    const ar = w.querySelector('#addr'); if (ar) ar.onclick = () => { readInto(w); draft.shape.rows = [...(draft.shape.rows || []), { l: '', w: '' }]; rerender(false); };
    const as = w.querySelector('#adds'); if (as) as.onclick = () => { readInto(w); draft.shape.sides = [...(draft.shape.sides || []), '']; rerender(false); };
    const ty = w.querySelector('[name=type]'); if (ty && !area) ty.onchange = () => { const c = w.querySelector('[name=code]'); if (/^[A-Z]\d+$/i.test(c.value) || !c.value) c.value = nextCode(areas, ty.value); };
    const ov = w.querySelector('#ovr'); if (ov) ov.onchange = live;
    const ph = w.querySelector('#ph'); if (ph) ph.onchange = async () => {
      for (const file of ph.files) {
        try {
          const small = await shrinkImage(file);
          const path = `${project.id}/${uid()}.jpg`;
          await store.upload('photos', path, small);
          draft.photos.push({ path, at: new Date().toISOString() });
          photoUrls[path] = URL.createObjectURL(small);
        } catch (e) { toast('Photo upload failed: ' + e.message); }
      }
      rerender();
    };
    w.querySelectorAll('[data-ph]').forEach(img => img.onclick = () => window.open(img.src, '_blank'));
    if (focusEdge != null) { const el = w.querySelector(`[data-edge="${focusEdge}"]`); if (el) setTimeout(() => { el.focus(); el.select(); }, 60); focusEdge = null; }
  };
  // load existing photo URLs
  for (const p of draft.photos) { try { photoUrls[p.path] = await store.fileUrl('photos', p.path); } catch (e) { } }

  const res = await dialog({
    title: area ? `Area ${area.code || ''}` : (isMap ? 'New area from the map' : 'Add area'),
    wide: true, body: body(),
    onOpen: w => { wrapRef = w; wire(w); },
    buttons: [
      ...(area ? [{ label: 'Delete', danger: true, value: 'delete' }] : []),
      { label: 'Cancel', value: null },
      { label: area ? 'Save' : 'Add area', primary: true, value: w => { readInto(w); return 'save'; } },
    ],
  });
  if (!res) return null;
  if (res === 'delete') {
    if (!(await confirmDlg('Delete area?', `Delete ${area.code || 'this area'} and its spec lines?`))) return null;
    await store.remove('areas', area.id); toast('Area deleted'); return 'deleted';
  }
  const m = areaMeasures(draft);
  const row = {
    project_id: project.id, code: draft.code || null, name: draft.name || null, type: draft.type, notes: draft.notes || null,
    source: area?.source || (g ? 'map' : 'manual'), geom: g || null,
    edges: isMap ? draft.edges : null, shape: isMap ? null : draft.shape,
    traced_area: isMap ? m.tracedArea : null, area_mode: draft.area_mode, area_override: draft.area_override,
    final_area: m.area, final_length: m.length, final_count: m.count, photos: draft.photos,
  };
  const saved = area ? await store.update('areas', area.id, row) : await store.insert('areas', { ...row, sort: areas.length });
  toast(area ? 'Area saved' : `${row.code || 'Area'} added to Areas`);
  return saved;
}

async function shrinkImage(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
}
