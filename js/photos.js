// Photos taken on the phone: shrink before upload so they work on a weak site signal.
import { uid, toast } from './util.js';

export async function shrink(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file); const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
  } catch (e) { return file; }
}

// Upload one picked/taken photo; returns { path, url } (url is a local preview).
export async function uploadPhoto(store, file, prefix = 'misc') {
  const blob = /^image\//.test(file.type) ? await shrink(file) : file;
  const ext = /^image\//.test(file.type) ? 'jpg' : (file.name.split('.').pop() || 'bin').toLowerCase();
  const path = `${prefix}/${uid()}.${ext}`;
  await store.upload('photos', path, blob);
  return { path, url: URL.createObjectURL(blob), at: new Date().toISOString() };
}

// A "take photo" button that uploads and calls back. Use: photoInput('idf', 'ID front') then wirePhoto(...)
export const photoInput = (id, label, multiple = false) => `<label class="btn small">${label}<input type="file" accept="image/*" capture="environment" id="${id}" hidden ${multiple ? 'multiple' : ''}></label>`;
export function wirePhoto(root, id, store, prefix, onDone) {
  const i = root.querySelector('#' + id); if (!i) return;
  i.onchange = async e => {
    for (const f of e.target.files) { try { onDone(await uploadPhoto(store, f, prefix)); } catch (err) { toast('Photo upload failed: ' + err.message); } }
    i.value = '';
  };
}
export async function photoUrls(store, paths) {
  const out = {};
  for (const p of paths.filter(Boolean)) { try { out[p] = await store.fileUrl('photos', p); } catch (e) { } }
  return out;
}
export const thumb = (url, alt = 'Photo', size = 72) => url ? `<img alt="${alt}" src="${url}" style="width:${size}px;height:${size}px;object-fit:cover;border-radius:8px;border:1px solid var(--line)">` : '';
