// Finger / mouse signature pad. Returns a PNG data URL (or null if left blank).
import { dialog, esc } from './util.js';

export async function captureSignature(title, who = '') {
  let pad;
  const v = await dialog({
    title,
    body: `${who ? `<p class="muted">Signing: <b>${esc(who)}</b></p>` : ''}
      <div style="border:2px dashed var(--line);border-radius:10px;background:#fff;touch-action:none"><canvas id="sig" style="width:100%;height:200px;display:block"></canvas></div>
      <div class="row"><span class="small muted grow">Sign with a finger or mouse inside the box.</span><button class="btn small" type="button" id="clr">Clear</button></div>`,
    onOpen: w => { pad = makePad(w.querySelector('#sig')); w.querySelector('#clr').onclick = () => pad.clear(); },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save signature', primary: true, value: () => pad.empty() ? 'blank' : pad.toDataURL() }],
  });
  return v === 'blank' ? null : v;
}

function makePad(canvas) {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  canvas.width = r.width * ratio; canvas.height = r.height * ratio;
  const c = canvas.getContext('2d');
  c.scale(ratio, ratio); c.lineWidth = 2.4; c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = '#0d2a6b';
  let drawing = false, last = null, marks = 0;
  const pos = e => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  canvas.addEventListener('pointerdown', e => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); c.beginPath(); c.arc(last[0], last[1], 1, 0, Math.PI * 2); c.fillStyle = c.strokeStyle; c.fill(); marks++; });
  canvas.addEventListener('pointermove', e => { if (!drawing) return; const p = pos(e); c.beginPath(); c.moveTo(last[0], last[1]); c.lineTo(p[0], p[1]); c.stroke(); last = p; marks++; });
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  return {
    clear() { c.clearRect(0, 0, canvas.width, canvas.height); marks = 0; },
    empty() { return marks < 3; },
    toDataURL() {
      // crop to a white-background JPEG-sized PNG to keep it small
      const out = document.createElement('canvas'); out.width = canvas.width / ratio; out.height = canvas.height / ratio;
      const o = out.getContext('2d'); o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height); o.drawImage(canvas, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    },
  };
}
