// Live site map: satellite imagery, GPS location, trace areas / runs / points,
// automatic side lengths and areas, tap a side to enter the tape-measured length.
import { esc, fmt, toast, dialog, num, typeColor } from './util.js';
import { edgeLengths, polygonArea, midpoint, centroid, areaMeasures } from './geo.js';
import { editArea, sortAreas } from './areas.js';

const L = window.L;
const ESRI_IMG = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_LBL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export async function render(root, ctx) {
  const { store } = ctx;
  let project = ctx.project;
  let areas = sortAreas(await store.list('areas', { project_id: project.id }));

  root.innerHTML = `<div class="mapwrap" id="mw">
    <div id="map" role="application" aria-label="Site map"></div>
    <div class="maptools" id="tools"></div>
    <div class="mapbar" id="bar" hidden></div>
  </div>`;
  const mw = root.querySelector('#mw');
  const fit = () => { mw.style.height = Math.max(380, window.innerHeight - mw.getBoundingClientRect().top) + 'px'; map && map.invalidateSize(); };

  const sat = L.tileLayer(ESRI_IMG, { maxNativeZoom: 19, maxZoom: 22, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' });
  const lbl = L.tileLayer(ESRI_LBL, { maxNativeZoom: 19, maxZoom: 22, opacity: .9 });
  const street = L.tileLayer(OSM, { maxNativeZoom: 19, maxZoom: 22, attribution: '© OpenStreetMap contributors' });
  const map = L.map(root.querySelector('#map'), { zoomControl: false, layers: [sat, lbl], maxZoom: 22, tap: true });
  if (!('ontouchstart' in window)) L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(map);
  let baseSat = true;

  const areaLayer = L.layerGroup().addTo(map);
  const labelLayer = L.layerGroup().addTo(map);
  const edgeLayer = L.layerGroup().addTo(map);
  const drawLayer = L.layerGroup().addTo(map);

  // ---- state
  let mode = 'view';          // view | draw | reshape
  let drawKind = null;        // polygon | line | point
  let pts = [];               // drawing vertices [lat,lng]
  let selected = null;        // area id
  let reshapeCoords = null;
  let meMarker = null, meCircle = null, meLatLng = null, watchId = null, firstFix = true;

  // ---- location
  function startLocate(center) {
    if (!navigator.geolocation) { toast('This device has no location service.'); return; }
    if (watchId != null) { if (center && meLatLng) map.setView(meLatLng, Math.max(map.getZoom(), 19)); return; }
    firstFix = center;
    watchId = navigator.geolocation.watchPosition(async pos => {
      const ll = [pos.coords.latitude, pos.coords.longitude]; meLatLng = ll;
      if (!meMarker) {
        meCircle = L.circle(ll, { radius: pos.coords.accuracy, color: '#2D8CFF', weight: 1, fillOpacity: .12, interactive: false }).addTo(map);
        meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [0, 0] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      } else { meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(pos.coords.accuracy); }
      if (firstFix) {
        firstFix = false;
        map.setView(ll, 19);
        if (project.lat == null) {
          project = await store.update('projects', project.id, { lat: ll[0], lng: ll[1], zoom: 19 }) || project;
          toast(`Site location saved (±${Math.round(pos.coords.accuracy)} m)`);
        }
      }
    }, err => { toast(err.code === 1 ? 'Location is blocked. Allow location for this app in your phone settings.' : 'Could not get your location.'); watchId = null; }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }

  // ---- initial view
  const allCoords = areas.flatMap(a => a.geom?.coords || []);
  if (allCoords.length) map.fitBounds(L.latLngBounds(allCoords).pad(0.15), { maxZoom: 20 });
  else if (project.lat != null) map.setView([project.lat, project.lng], project.zoom || 19);
  else map.setView([-26.49, 31.38], 9); // Eswatini, until GPS answers
  startLocate(!allCoords.length && project.lat == null);

  // ---- draw existing areas
  function drawAreas() {
    areaLayer.clearLayers(); labelLayer.clearLayers(); edgeLayer.clearLayers();
    const showEdges = map.getZoom() >= 18;
    for (const a of areas) {
      if (!a.geom?.coords?.length) continue;
      if (mode === 'reshape' && a.id === selected) continue;
      const col = typeColor(a.type), sel = a.id === selected, c = a.geom.coords;
      let shape;
      if (a.geom.kind === 'polygon') shape = L.polygon(c, { color: sel ? '#ffffff' : col, weight: sel ? 4 : 2.5, fillColor: col, fillOpacity: sel ? .45 : .28 });
      else if (a.geom.kind === 'line') shape = L.polyline(c, { color: sel ? '#ffffff' : col, weight: sel ? 6 : 4 });
      else { c.forEach(p => L.circleMarker(p, { radius: 8, color: '#fff', weight: 2, fillColor: col, fillOpacity: 1 }).on('click', e => { L.DomEvent.stop(e); select(a.id); }).addTo(areaLayer)); }
      if (shape) shape.on('click', e => { if (mode !== 'view') return; L.DomEvent.stop(e); select(a.id); }).addTo(areaLayer);
      const m = areaMeasures(a);
      const at = a.geom.kind === 'polygon' ? centroid(c) : c[Math.floor(c.length / 2)];
      const val = m.area ? `${fmt(m.area, 1)} m²` : m.length ? `${fmt(m.length, 1)} m` : m.count ? `${m.count} no.` : '';
      L.marker(at, { interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="area-lbl">${esc(a.code || '')}<small>${val}</small></span>` }) }).addTo(labelLayer);
      if ((showEdges || sel) && a.geom.kind !== 'point') {
        m.edges.forEach((e, i) => {
          const p1 = c[i], p2 = c[(i + 1) % c.length];
          const meas = e.measured != null;
          L.marker(midpoint(p1, p2), { icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="edge-lbl ${meas ? 'meas' : ''}" title="Tap to enter the measured length">${fmt(meas ? e.measured : e.traced, meas ? 2 : 1)} m${meas ? ' ✎' : ''}</span>` }) })
            .on('click', ev => { L.DomEvent.stop(ev); if (mode === 'view') editEdge(a, i); }).addTo(edgeLayer);
        });
      }
    }
  }
  map.on('zoomend', () => { if (mode === 'view') drawAreas(); });

  async function reloadAreas() { areas = sortAreas(await store.list('areas', { project_id: project.id })); drawAreas(); if (mode === 'view') tools(); }

  // ---- tap a side → measured override
  async function editEdge(a, i) {
    const m = areaMeasures(a), e = m.edges[i];
    const v = await dialog({
      title: `${a.code || 'Area'} · side ${i + 1}`,
      body: `<p class="muted">Traced on the map: <b>${fmt(e.traced, 2)} m</b></p>
        <label class="f">Measured length (m)<input name="m" inputmode="decimal" value="${e.measured ?? ''}" placeholder="${fmt(e.traced, 2)}"></label>
        <p class="note">Your measurement replaces the traced length for this side. The area is then adjusted to your measured sides (you can change this in the area's details).</p>`,
      buttons: [...(e.measured != null ? [{ label: 'Use traced length', value: 'clear' }] : []), { label: 'Cancel', value: null }, { label: 'Save', primary: true, value: w => w.querySelector('[name=m]').value }],
    });
    if (v == null) return;
    const edges = m.edges.map(x => ({ measured: x.measured }));
    edges[i].measured = v === 'clear' ? null : num(v);
    const area_mode = a.area_mode === 'manual' ? 'manual' : null;
    const next = { ...a, edges, area_mode };
    const mm = areaMeasures(next);
    await store.update('areas', a.id, { edges, area_mode, final_area: mm.area, final_length: mm.length, final_count: mm.count });
    toast(v === 'clear' ? 'Side reset to traced length' : `Side ${i + 1} set to ${fmt(num(v), 2)} m`);
    await reloadAreas(); if (selected) showSelected();
  }

  // ---- selection
  function select(id) { selected = id; drawAreas(); showSelected(); }
  function showSelected() {
    const a = areas.find(x => x.id === selected); if (!a) { bar.hidden = true; return; }
    const m = areaMeasures(a);
    bar.hidden = false;
    bar.innerHTML = `<span class="code" style="background:${typeColor(a.type)}">${esc(a.code || '—')}</span>
      <div class="grow"><div>${esc(a.name || a.type)}</div><div class="big">${m.area ? fmt(m.area, 1) + ' m²' : m.length ? fmt(m.length, 1) + ' m' : (m.count || 0) + ' no.'}${m.perimeter ? ` <span style="font:500 13px var(--body);opacity:.8">· perimeter ${fmt(m.perimeter, 1)} m</span>` : ''}</div>
      <div class="small" style="opacity:.8">Tap a side's length to enter a measured value.</div></div>
      <button class="btn small" id="b-det">Details</button>${a.geom.kind !== 'point' ? '<button class="btn small" id="b-rs">Reshape</button>' : ''}<button class="btn small" id="b-x">Close</button>`;
    bar.querySelector('#b-det').onclick = async () => { const r = await editArea(ctx, a, { areas }); if (r) { if (r === 'deleted') selected = null; await reloadAreas(); selected ? showSelected() : (bar.hidden = true); } };
    bar.querySelector('#b-rs') && (bar.querySelector('#b-rs').onclick = () => startReshape(a));
    bar.querySelector('#b-x').onclick = () => { selected = null; bar.hidden = true; drawAreas(); };
  }

  // ---- drawing new shapes
  function startDraw(kind) {
    mode = 'draw'; drawKind = kind; pts = []; selected = null; map.doubleClickZoom.disable(); drawAreas(); tools(); updateDraw();
    toast(kind === 'point' ? 'Tap to drop points (trees, sumps…)' : 'Tap each corner in turn. Use “Add my position” to walk the boundary.');
  }
  function updateDraw() {
    drawLayer.clearLayers();
    if (drawKind !== 'point' && pts.length >= 2) {
      (drawKind === 'polygon' && pts.length >= 3 ? L.polygon(pts, { color: '#fff', weight: 2.5, dashArray: '6 6', fillOpacity: .2 }) : L.polyline(pts, { color: '#fff', weight: 3, dashArray: '6 6' })).addTo(drawLayer);
      const closed = drawKind === 'polygon' && pts.length >= 3;
      edgeLengths(pts, closed).forEach((d, i) => L.marker(midpoint(pts[i], pts[(i + 1) % pts.length]), { interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="edge-lbl live">${fmt(d, 1)} m</span>` }) }).addTo(drawLayer));
    }
    pts.forEach((p, i) => {
      const mk = L.marker(p, { draggable: true, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="vtx ${i === 0 ? 'first' : ''}"></div>` }) }).addTo(drawLayer);
      mk.on('drag', e => { pts[i] = [e.latlng.lat, e.latlng.lng]; });
      mk.on('dragend', updateDraw);
      if (i === 0 && drawKind === 'polygon') mk.on('click', () => { if (pts.length >= 3) finishDraw(); });
    });
    const closed = drawKind === 'polygon' && pts.length >= 3;
    const per = edgeLengths(pts, closed).reduce((a, b) => a + b, 0);
    bar.hidden = false;
    bar.innerHTML = `<div class="grow"><div class="small" style="opacity:.85">${drawKind === 'polygon' ? 'Tracing an area' : drawKind === 'line' ? 'Tracing a line / run' : 'Dropping points'} · ${pts.length} point${pts.length === 1 ? '' : 's'}</div>
      <div class="big">${drawKind === 'polygon' ? `${fmt(closed ? polygonArea(pts) : 0, 1)} m² <span style="font:500 13px var(--body);opacity:.8">· ${fmt(per, 1)} m around</span>` : drawKind === 'line' ? `${fmt(per, 1)} m` : `${pts.length} no.`}</div></div>
      <button class="btn small" id="d-me">Add my position</button>
      <button class="btn small" id="d-undo" ${pts.length ? '' : 'disabled'}>Undo</button>
      <button class="btn small" id="d-cancel">Cancel</button>
      <button class="btn small primary" id="d-done" ${pts.length >= (drawKind === 'polygon' ? 3 : drawKind === 'line' ? 2 : 1) ? '' : 'disabled'}>Finish</button>`;
    bar.querySelector('#d-me').onclick = () => { if (!meLatLng) { startLocate(false); return toast('Waiting for GPS…'); } pts.push([...meLatLng]); updateDraw(); };
    bar.querySelector('#d-undo').onclick = () => { pts.pop(); updateDraw(); };
    bar.querySelector('#d-cancel').onclick = endDraw;
    bar.querySelector('#d-done').onclick = finishDraw;
  }
  async function finishDraw() {
    const geom = { kind: drawKind, coords: pts.map(p => [+p[0].toFixed(8), +p[1].toFixed(8)]) };
    const r = await editArea(ctx, null, { areas, geom });
    if (!r) return; // keep drawing so nothing is lost
    endDraw(); await reloadAreas();
    if (r && r.id) select(r.id);
  }
  function endDraw() { map.doubleClickZoom.enable(); mode = 'view'; drawKind = null; pts = []; drawLayer.clearLayers(); bar.hidden = true; tools(); drawAreas(); }
  map.on('click', e => {
    if (mode === 'draw') { pts.push([e.latlng.lat, e.latlng.lng]); updateDraw(); }
    else if (mode === 'view' && selected) { selected = null; bar.hidden = true; drawAreas(); }
  });

  // ---- reshape
  function startReshape(a) {
    mode = 'reshape'; reshapeCoords = a.geom.coords.map(p => [...p]); tools(); drawAreas(); drawReshape(a);
  }
  function drawReshape(a) {
    drawLayer.clearLayers();
    const closed = a.geom.kind === 'polygon', c = reshapeCoords;
    (closed ? L.polygon(c, { color: '#fff', weight: 2.5, fillColor: typeColor(a.type), fillOpacity: .3 }) : L.polyline(c, { color: '#fff', weight: 4 })).addTo(drawLayer);
    edgeLengths(c, closed).forEach((d, i) => {
      const mp = midpoint(c[i], c[(i + 1) % c.length]);
      L.marker(mp, { icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="edge-lbl live" title="Tap to add a corner here">${fmt(d, 1)} m ＋</span>` }) })
        .on('click', ev => { L.DomEvent.stop(ev); c.splice(i + 1, 0, mp); drawReshape(a); }).addTo(drawLayer);
    });
    c.forEach((p, i) => {
      const mk = L.marker(p, { draggable: true, icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="vtx"></div>' }) }).addTo(drawLayer);
      mk.on('dragend', e => { c[i] = [e.target.getLatLng().lat, e.target.getLatLng().lng]; drawReshape(a); });
      mk.on('contextmenu', () => { if (c.length > (closed ? 3 : 2)) { c.splice(i, 1); drawReshape(a); } });
    });
    const area = closed ? polygonArea(c) : 0, per = edgeLengths(c, closed).reduce((x, y) => x + y, 0);
    bar.hidden = false;
    bar.innerHTML = `<div class="grow"><div class="small" style="opacity:.85">Reshaping ${esc(a.code || '')} · drag corners, tap ＋ to add one, long-press a corner to remove it</div>
      <div class="big">${closed ? fmt(area, 1) + ' m²' : fmt(per, 1) + ' m'}</div></div>
      <button class="btn small" id="r-cancel">Cancel</button><button class="btn small primary" id="r-save">Save shape</button>`;
    bar.querySelector('#r-cancel').onclick = () => { mode = 'view'; drawLayer.clearLayers(); tools(); drawAreas(); showSelected(); };
    bar.querySelector('#r-save').onclick = async () => {
      const geom = { kind: a.geom.kind, coords: c.map(p => [+p[0].toFixed(8), +p[1].toFixed(8)]) };
      const sameCount = geom.coords.length === a.geom.coords.length;
      const edges = sameCount ? a.edges : null;
      const mm = areaMeasures({ ...a, geom, edges });
      await store.update('areas', a.id, { geom, edges, traced_area: mm.tracedArea, final_area: mm.area, final_length: mm.length });
      if (!sameCount && (a.edges || []).some(e => e?.measured != null)) toast('Corners changed, so measured side lengths were cleared.');
      else toast('Shape saved');
      mode = 'view'; drawLayer.clearLayers(); tools(); await reloadAreas(); showSelected();
    };
  }

  // ---- toolbar
  const toolsEl = root.querySelector('#tools'), bar = root.querySelector('#bar');
  function tools() {
    if (mode !== 'view') { toolsEl.innerHTML = `<button class="mbtn" id="t-loc">◎ My location</button>`; }
    else toolsEl.innerHTML = `
      <button class="mbtn go" id="t-area">＋ Trace area</button>
      <button class="mbtn" id="t-line">／ Trace line</button>
      <button class="mbtn" id="t-pt">• Points</button>
      <span style="flex:1"></span>
      <button class="mbtn" id="t-loc">◎ My location</button>
      <button class="mbtn" id="t-layer">${baseSat ? 'Street map' : 'Satellite'}</button>
      <a class="mbtn" href="#/p/${project.id}/areas">☰ Areas (${areas.length})</a>`;
    const on = (id, f) => { const el = toolsEl.querySelector(id); if (el) el.onclick = f; };
    on('#t-area', () => startDraw('polygon')); on('#t-line', () => startDraw('line')); on('#t-pt', () => startDraw('point'));
    on('#t-loc', () => startLocate(true));
    on('#t-layer', () => { baseSat = !baseSat; if (baseSat) { map.removeLayer(street); sat.addTo(map); lbl.addTo(map); } else { map.removeLayer(sat); map.removeLayer(lbl); street.addTo(map); } tools(); });
  }

  tools(); drawAreas();
  requestAnimationFrame(fit); window.addEventListener('resize', fit);
  return () => { window.removeEventListener('resize', fit); if (watchId != null) navigator.geolocation.clearWatch(watchId); map.remove(); };
}
