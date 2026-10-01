// Import outlines traced in Google Earth (File → Export as KML file) as areas.
import { toast, dialog, esc, fmt } from './util.js';
import { areaMeasures } from './geo.js';
import { nextCode } from './areas.js';

const TYPE_BY_PREFIX = { G: 'Garden', A: 'Earthworks', T: 'Works', L: 'Lawn', H: 'Hardscape', I: 'Irrigation' };

function text(desc) {
  const d = document.createElement('div');
  d.innerHTML = (desc || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n');
  return d.textContent.split('\n').map(s => s.trim()).filter(Boolean).join('; ');
}

export function parseKml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out = [];
  doc.querySelectorAll('Placemark').forEach(pm => {
    const name = pm.querySelector('name')?.textContent?.trim() || '';
    const desc = text(pm.querySelector('description')?.textContent);
    const poly = pm.querySelector('Polygon outerBoundaryIs coordinates, Polygon coordinates');
    const line = pm.querySelector('LineString coordinates');
    const point = pm.querySelector('Point coordinates');
    const node = poly || line || point; if (!node) return;
    let coords = node.textContent.trim().split(/\s+/).map(s => s.split(',').map(Number)).filter(c => c.length >= 2 && !isNaN(c[0])).map(c => [c[1], c[0]]);
    const kind = poly ? 'polygon' : line ? 'line' : 'point';
    if (kind === 'polygon' && coords.length > 3) { const f = coords[0], l = coords[coords.length - 1]; if (f[0] === l[0] && f[1] === l[1]) coords = coords.slice(0, -1); }
    out.push({ name, desc, geom: { kind, coords } });
  });
  return out;
}

export async function importKml(ctx, existing) {
  const { store, project } = ctx;
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.kml,application/vnd.google-earth.kml+xml,text/xml';
  input.onchange = async () => {
    const f = input.files[0]; if (!f) return;
    if (/\.kmz$/i.test(f.name)) return toast('Please export as KML (not KMZ) from Google Earth.');
    const items = parseKml(await f.text());
    if (!items.length) return toast('No outlines found in that file.');
    const ok = await dialog({
      title: `Import ${items.length} outlines`, wide: true,
      body: `<p class="muted">From <b>${esc(f.name)}</b>. Each outline becomes an area you can edit, measure and spec.</p>
        <div class="tbl"><table><thead><tr><th>Name</th><th>Shape</th><th class="n">Size</th></tr></thead><tbody>
        ${items.map(i => { const m = areaMeasures({ geom: i.geom }); return `<tr><td>${esc(i.name)}</td><td>${i.geom.kind}</td><td class="n">${m.area ? fmt(m.area, 1) + ' m²' : m.length ? fmt(m.length, 1) + ' m' : (m.count || 1) + ' no.'}</td></tr>`; }).join('')}
        </tbody></table></div>`,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Import', primary: true, value: true }],
    });
    if (!ok) return;
    const all = [...existing];
    const rows = items.map((i, k) => {
      const compact = i.name.replace(/\s+/g, '');
      const m0 = compact.match(/^([A-Z])\d+[A-Z]?$/i);
      const type = m0 ? (TYPE_BY_PREFIX[m0[1].toUpperCase()] || 'Other') : (/circle|garden|bed|entrance/i.test(i.name) ? 'Garden' : 'Other');
      const code = m0 ? compact.toUpperCase() : nextCode(all, type);
      const row = { project_id: project.id, code, name: m0 ? '' : i.name, type, source: 'kml', geom: i.geom, notes: i.desc || null, sort: existing.length + k, photos: [] };
      const m = areaMeasures(row);
      Object.assign(row, { traced_area: m.tracedArea, final_area: m.area, final_length: m.length, final_count: m.count });
      all.push(row);
      return row;
    });
    await store.insert('areas', rows);
    const c = rows.flatMap(r => r.geom.coords);
    if (project.lat == null && c.length) await store.update('projects', project.id, { lat: c.reduce((a, p) => a + p[0], 0) / c.length, lng: c.reduce((a, p) => a + p[1], 0) / c.length, zoom: 19 });
    toast(`Imported ${rows.length} areas`);
    ctx.reload();
  };
  input.click();
}
