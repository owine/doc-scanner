// Renders the PWA's icons from the page-and-dot mark. Run by hand after
// changing the mark; the outputs are committed, so builds never run this.
// Lives in server/ because sharp is a server dependency, and Node resolves it
// from the script's own location.
//   cd server && node scripts/render-pwa-icons.mjs
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const INK = '#0e1620';
const PAPER = '#f6f4ef';
const ACCENT = '#2b5fd9';
const out = (name) => fileURLToPath(new URL(`../../pwa/public/icons/${name}`, import.meta.url));

// The in-app mark is pwa/src/ui/Mark.tsx: change both together.
/** The mark on a 32-unit grid. */
const mark = (stroke, dot) =>
  `<path d="M10 6.5h8.5l4 4V25.5H10z" fill="none" stroke="${PAPER}" stroke-width="${stroke}" stroke-linejoin="round"/>` +
  `<path d="M18.5 6.5v4h4" fill="none" stroke="${PAPER}" stroke-width="${stroke}" stroke-linejoin="round"/>` +
  `<circle cx="24.5" cy="24" r="${dot}" fill="${ACCENT}"/>`;

const svg = (body, rx = 0) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="${rx}" fill="${INK}"/>${body}</svg>`;

// Full bleed: the OS applies its own mask to "any" icons.
const fullBleed = svg(mark(1.6, 2));
// Maskable: the art scaled into the central 80% safe zone.
const maskable = svg(`<g transform="translate(16 16) scale(0.8) translate(-16 -16)">${mark(1.6, 2)}</g>`);
// Favicon: owine's rounded square, a heavier stroke for 16 px.
const favicon = svg(mark(2, 2.2), 6);

async function png(source, size, name) {
  await sharp(Buffer.from(source), { density: (72 * size) / 32 }).resize(size, size).png().toFile(out(name));
}

await writeFile(out('favicon.svg'), `${favicon}\n`);
await png(fullBleed, 192, 'icon-192.png');
await png(fullBleed, 512, 'icon-512.png');
await png(maskable, 512, 'icon-maskable-512.png');
await png(fullBleed, 180, 'apple-touch-icon.png');
console.log('wrote favicon.svg, icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png');
