// Key faces for Winged Keys: Greek-gold design.
// Text is drawn as Cinzel glyph outlines (SIL Open Font License, see Cinzel-OFL.txt), so it looks
// the same on every device without relying on the app's font support.
const FONT = require('./cinzel-glyphs.json');

const PAL = {
  bg: '#161410', edge: '#2e2a22', frame: '#6b5a33',
  gold: '#d4af37', text: '#f1e9d6', muted: '#d6c9a6',
};

// 24x24 stroke icons (gold by default)
const ICONS = {
  status: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  ask: '<path d="M5 4h14v4c0 4-3 6-7 6s-7-2-7-6z"/><path d="M9 14v2h6v-2M8 20h8M12 16v4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  usage: '<path d="M4 20h16M6 20V9M10 20V9M14 20V9M18 20V9M3 9h18L12 4z"/>',
  platforms: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8 8l8 8M16 8l-8 8"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/>',
  agent: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3-6.5 7-6.5s7 2.5 7 6.5"/>',
  session: '<path d="M4 5h16v10H9l-5 4z"/><path d="M12 7.5v5M9.5 10h5"/>',
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

// Text size: "normal" | "large" | "xl". Large is the default.
const SIZES = { normal: 1, large: 1.25, xl: 1.5 };
let S = SIZES.large;
function setTextSize(name) { S = SIZES[name] || SIZES.large; }

// Stacks lines of [text, opts] vertically, centered in the key below the top line.
function stack(items) {
  const cap = (sz) => sz * 0.72; // Cinzel cap height ~0.7 em
  const heights = items.map((it) => it.h != null ? it.h : cap(it.size));
  const gaps = items.map((it, i) => (i === 0 ? 0 : (it.gap != null ? it.gap : 8 * S)));
  const total = heights.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
  let y = 76 - total / 2;
  let out = '';
  items.forEach((it, i) => {
    y += gaps[i];
    if (it.draw) out += it.draw(y, heights[i]);
    else out += text(it.str, { size: it.size, y: y + heights[i], color: it.color, weight: it.weight || 700, spacing: it.spacing || 0, maxW: it.maxW || 128 });
    y += heights[i];
  });
  return out;
}

// A number with a caption: usage, platforms.
function valueFace(value, color, caption) {
  const v = String(value).slice(0, 8);
  const lines = String(caption || '').split('\n').filter(Boolean).slice(0, 2);
  const valSize = (v.length > 4 ? 40 : 48) * Math.min(S, 1.15);
  const items = [{ str: v, size: valSize, color, maxW: 128 }];
  lines.forEach((l, i) => items.push({ str: l.toUpperCase(), size: 13 * S, color: PAL.muted, weight: 500, spacing: 0.1, gap: i === 0 ? 12 * S : 5 * S }));
  return frame(stack(items), { value: v, label: caption });
}

// Status: a colored dot, a name and a state word.
function statusFace(color, title) {
  const [name = 'Hermes', state = ''] = String(title).split('\n');
  const r = 6 * S;
  const items = [
    { h: r * 2, draw: (y) => `<circle cx="72" cy="${(y + r).toFixed(1)}" r="${r.toFixed(1)}" fill="${color}"/>` },
    { str: name.toUpperCase(), size: 18 * S, color: PAL.text, spacing: 0.08, gap: 12 * S },
  ];
  if (state) items.push({ str: state.toUpperCase(), size: 14 * S, color, weight: 500, spacing: 0.08, gap: 9 * S });
  return frame(stack(items), { value: state, label: title });
}

// An action icon with a label underneath; the icon takes the state color when busy or in error.
function iconFace(kind, color, title) {
  const lines = String(title).split('\n').filter(Boolean).slice(0, 2);
  const iconPx = Math.round(46 / Math.pow(S, 0.3));
  const items = [{ h: iconPx, draw: (y) => `<g transform="translate(${(72 - iconPx / 2).toFixed(1)} ${y.toFixed(1)}) scale(${(iconPx / 24).toFixed(4)})" fill="none" stroke="${color}" color="${color}" stroke-width="${(1.3 * Math.sqrt(S)).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind] || ICONS.open}</g>` }];
  lines.forEach((l, i) => items.push({ str: l.toUpperCase(), size: (i === 0 ? 15 : 12) * S, color: i === 0 ? PAL.text : PAL.muted, weight: i === 0 ? 700 : 500, spacing: 0.08, gap: i === 0 ? 12 * S : 5 * S }));
  return frame(stack(items), { value: '', label: title });
}

module.exports = { PAL, valueFace, statusFace, iconFace, setTextSize };
