// Key faces for Winged Keys: Greek-gold design.
// Text is drawn as Cinzel glyph outlines (SIL Open Font License, see Cinzel-OFL.txt), so it looks
// the same on every device without relying on the app's font support.
const FONT = require('./cinzel-glyphs.json');

const PAL = {
  bg: '#161410', edge: '#2e2a22', frame: '#6b5a33',
  gold: '#d4af37', text: '#f1e9d6', muted: '#b9ab8d',
};

// 24x24 stroke icons (gold by default)
const ICONS = {
  status: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  ask: '<path d="M5 4h14v4c0 4-3 6-7 6s-7-2-7-6z"/><path d="M9 14v2h6v-2M8 20h8M12 16v4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  usage: '<path d="M4 20h16M6 20V9M10 20V9M14 20V9M18 20V9M3 9h18L12 4z"/>',
  platforms: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8 8l8 8M16 8l-8 8"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/>',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Lays out one line of text as glyph paths, centered on x, baseline y, shrunk to fit maxW.
function text(str, { size, y, x = 72, color, weight = 700, spacing = 0, maxW = 124 }) {
  const f = FONT[String(weight)] || FONT['700'];
  const chars = [...String(str)].slice(0, 24);
  if (!chars.length) return '';
  const gap = spacing * f.upm;
  const glyphs = chars.map((ch) => f.g[ch] || f.g[ch.toUpperCase()] || f.g['?']);
  const total = glyphs.reduce((w, g) => w + g[0], 0) + gap * (glyphs.length - 1);
  let k = size / f.upm;
  if (total * k > maxW) k = maxW / total;
  let ox = x - (total * k) / 2;
  let out = '';
  for (const g of glyphs) {
    if (g[1]) out += `<path transform="translate(${ox.toFixed(2)} ${y}) scale(${k.toFixed(5)} ${(-k).toFixed(5)})" d="${g[1]}"/>`;
    ox += (g[0] + gap) * k;
  }
  return `<g fill="${color}">${out}</g>`;
}

function frame(inner, meta) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144" data-value="${esc(meta.value || '')}" data-label="${esc(meta.label || '')}">`
    + `<rect x="0.5" y="0.5" width="143" height="143" rx="12" fill="${PAL.bg}" stroke="${PAL.edge}"/>`
    + `<path d="M14 1.5H130" stroke="${PAL.frame}" stroke-width="2" stroke-linecap="round"/>`
    + inner + '</svg>';
  return 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg);
}

// A number with a small caption: usage, platforms.
function valueFace(value, color, caption) {
  const v = String(value).slice(0, 8);
  const lines = String(caption || '').split('\n').filter(Boolean);
  let inner = text(v, { size: v.length > 4 ? 40 : 46, y: lines.length > 1 ? 76 : 82, color, maxW: 122 });
  if (lines[0]) inner += text(lines[0].toUpperCase(), { size: 12, y: lines.length > 1 ? 102 : 112, color: PAL.muted, weight: 500, spacing: 0.16 });
  if (lines[1]) inner += text(lines[1].toUpperCase(), { size: 11, y: 120, color: PAL.muted, weight: 500, spacing: 0.16 });
  return frame(inner, { value: v, label: caption });
}

// Status: a colored dot, a name and a state word.
function statusFace(color, title) {
  const [name = 'Hermes', state = ''] = String(title).split('\n');
  const inner = `<circle cx="72" cy="44" r="7" fill="${color}"/>`
    + text(name.toUpperCase(), { size: 17, y: 84, color: PAL.text, spacing: 0.12 })
    + text(state.toUpperCase(), { size: 12, y: 110, color: state ? color : PAL.muted, weight: 500, spacing: 0.16 });
  return frame(inner, { value: state, label: title });
}

// An action icon with a label underneath; the icon takes the state color when busy or in error.
function iconFace(kind, color, title) {
  const lines = String(title).split('\n').filter(Boolean);
  const icon = `<g transform="translate(50 26) scale(1.8333)" fill="none" stroke="${color}" color="${color}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind] || ICONS.open}</g>`;
  let inner = icon + text((lines[0] || '').toUpperCase(), { size: 14, y: lines.length > 1 ? 100 : 108, color: PAL.text, spacing: 0.12 });
  if (lines[1]) inner += text(lines[1].toUpperCase(), { size: 11, y: 120, color: PAL.muted, weight: 500, spacing: 0.16 });
  return frame(inner, { value: '', label: title });
}

module.exports = { PAL, valueFace, statusFace, iconFace };
