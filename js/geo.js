// Geometry on the earth's surface for site-scale shapes (local tangent-plane projection;
// accurate to well under 0.1% over a few hundred metres).
const R = 6378137;
const rad = d => d * Math.PI / 180;

function project(coords) {
  const lat0 = coords.reduce((a, c) => a + c[0], 0) / coords.length;
  const lng0 = coords.reduce((a, c) => a + c[1], 0) / coords.length;
  const k = Math.cos(rad(lat0));
  return coords.map(([la, ln]) => [rad(ln - lng0) * R * k, rad(la - lat0) * R]);
}

export function distance(a, b) {
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function polygonArea(coords) {
  if (!coords || coords.length < 3) return 0;
  const p = project(coords);
  let s = 0;
  for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; s += p[i][0] * p[j][1] - p[j][0] * p[i][1]; }
  return Math.abs(s) / 2;
}

// Edge lengths: closed ring for polygons, open chain for lines.
export function edgeLengths(coords, closed) {
  const out = [];
  const n = coords.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) out.push(distance(coords[i], coords[(i + 1) % n]));
  return out;
}

export function midpoint(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }

export function centroid(coords) {
  if (coords.length < 3) return coords[0];
  const p = project(coords);
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length, f = p[i][0] * p[j][1] - p[j][0] * p[i][1];
    a += f; cx += (p[i][0] + p[j][0]) * f; cy += (p[i][1] + p[j][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return coords[0];
  cx /= 3 * a; cy /= 3 * a;
  const lat0 = coords.reduce((s, c) => s + c[0], 0) / coords.length;
  const lng0 = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  return [lat0 + cy / R * 180 / Math.PI, lng0 + cx / (R * Math.cos(rad(lat0))) * 180 / Math.PI];
}

// ---- Manual (no-map) shapes ------------------------------------------
export const SHAPES = {
  rect: { label: 'Rectangle (length × width)', fields: [['l', 'Length (m)'], ['w', 'Width (m)']] },
  tri: { label: 'Triangle (3 sides)', fields: [['a', 'Side a (m)'], ['b', 'Side b (m)'], ['c', 'Side c (m)']] },
  circle: { label: 'Circle (diameter)', fields: [['d', 'Diameter (m)']] },
  rects: { label: 'Several rectangles added together', fields: [] },
  sides: { label: 'Irregular (measured sides + area)', fields: [] },
  linear: { label: 'Line / run (length)', fields: [['len', 'Length (m)'], ['w', 'Width (m, optional)']] },
  count: { label: 'Count (trees, sumps, items)', fields: [['n', 'Number']] },
};

// Returns {area, perimeter, length, count, edges[]} for a manual shape.
export function shapeMeasures(s) {
  const n = k => Number(s?.[k]) || 0;
  switch (s?.kind) {
    case 'rect': return { area: n('l') * n('w'), perimeter: 2 * (n('l') + n('w')), edges: [n('l'), n('w'), n('l'), n('w')] };
    case 'tri': { const a = n('a'), b = n('b'), c = n('c'), p = (a + b + c) / 2; const A = Math.sqrt(Math.max(0, p * (p - a) * (p - b) * (p - c))); return { area: A, perimeter: a + b + c, edges: [a, b, c] }; }
    case 'circle': return { area: Math.PI * n('d') ** 2 / 4, perimeter: Math.PI * n('d'), edges: [] };
    case 'rects': { const rows = s.rows || []; return { area: rows.reduce((t, r) => t + (Number(r.l) || 0) * (Number(r.w) || 0) * (r.minus ? -1 : 1), 0), perimeter: null, edges: [] }; }
    case 'sides': { const sides = (s.sides || []).map(Number).filter(x => x > 0); return { area: n('area'), perimeter: sides.reduce((a, b) => a + b, 0), edges: sides }; }
    case 'linear': return { area: n('w') ? n('len') * n('w') : null, length: n('len'), perimeter: null, edges: [n('len')] };
    case 'count': return { count: n('n'), area: null, edges: [] };
    default: return { area: null, edges: [] };
  }
}

// Final measures for any area (map-traced or manual), honouring edge overrides and area mode.
export function areaMeasures(a) {
  if (a.geom && a.geom.coords && a.geom.coords.length) {
    const g = a.geom, closed = g.kind === 'polygon';
    const traced = g.kind === 'point' ? [] : edgeLengths(g.coords, closed);
    const edges = traced.map((t, i) => ({ traced: t, measured: a.edges?.[i]?.measured ?? null }));
    const eff = edges.map(e => e.measured ?? e.traced);
    const tracedArea = closed ? polygonArea(g.coords) : 0;
    const tracedPer = traced.reduce((x, y) => x + y, 0), effPer = eff.reduce((x, y) => x + y, 0);
    const anyMeasured = edges.some(e => e.measured != null);
    const scaledArea = tracedPer ? tracedArea * (effPer / tracedPer) ** 2 : tracedArea;
    let mode = a.area_mode || (anyMeasured ? 'scaled' : 'traced');
    let area = !closed ? null : mode === 'manual' && a.area_override != null ? Number(a.area_override) : mode === 'scaled' ? scaledArea : tracedArea;
    return {
      kind: g.kind, edges, tracedArea, scaledArea, area, anyMeasured, mode,
      perimeter: closed ? effPer : null, length: g.kind === 'line' ? effPer : null, count: g.kind === 'point' ? g.coords.length : null,
    };
  }
  const m = shapeMeasures(a.shape || {});
  const area = a.area_mode === 'manual' && a.area_override != null ? Number(a.area_override) : m.area;
  return { kind: 'manual', edges: (m.edges || []).map(x => ({ traced: null, measured: x })), area, perimeter: m.perimeter ?? null, length: m.length ?? null, count: m.count ?? null, mode: a.area_mode || 'shape' };
}
