import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const source = join(repoRoot, 'src/renderer/public/brand/sentinel-shield-transparent.png');

// ── Composite: centered shield on white rounded-square background ────────────
// Tray + taskbar icons should match the app's light-mode logo. Render a
// white rounded square, then paste the trimmed shield in the center at
// ~68% of the canvas so it has consistent breathing room at every size.
async function buildIcon(size, { cornerRatio = 0.215, glyphRatio = 0.68 } = {}) {
  const radius = Math.round(size * cornerRatio);
  const bgSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
       <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#FFFFFF"/>
     </svg>`,
  );
  const glyphSize = Math.round(size * glyphRatio);
  const glyph = await sharp(source)
    .trim()
    .resize(glyphSize, glyphSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const offset = Math.round((size - glyphSize) / 2);
  return sharp(bgSvg)
    .composite([{ input: glyph, top: offset, left: offset }])
    .png()
    .toBuffer();
}

const sizes = [16, 24, 32, 48, 64, 128, 256];

for (const size of sizes) {
  const buf = await buildIcon(size);
  const out = join(here, `tray-icon-${size}.png`);
  writeFileSync(out, buf);
  console.log('wrote', out);
}

// Tray default (Windows/Linux pick 16/32 via resolver; macOS uses 22@2x).
writeFileSync(join(here, 'tray-icon.png'), await buildIcon(44));
console.log('wrote tray-icon.png');

// ── App icon (Windows taskbar + installer) ────────────────────────────────────
// Also regenerate build/icon.png and build/icon.ico so the taskbar shows
// the same centered shield-on-white, not the old dark-BG off-center glyph.
const appIconSizes = [16, 24, 32, 48, 64, 128, 256];
const appBuffers = [];
for (const size of appIconSizes) {
  const buf = await buildIcon(size);
  appBuffers.push(buf);
}
writeFileSync(join(here, 'icon.png'), await buildIcon(512));
console.log('wrote icon.png (512)');

const ico = await pngToIco(appBuffers);
writeFileSync(join(here, 'icon.ico'), ico);
console.log('wrote icon.ico');
