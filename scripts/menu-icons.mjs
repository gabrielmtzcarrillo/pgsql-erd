// Renders the icons in src/renderer/icons.js to the PNG files used by the
// native application menu (src/main/menu-icons). Run after changing icons:
//
//   npm run menu-icons
//
// Each icon is written at 16px and 32px (@2x), in its colours for light
// menus and in a "-dark" variant with lighter colours for dark menus.

import { app, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS, iconMarkup, iconTone } from '../src/renderer/icons.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/main/menu-icons');
const VARIANTS = [['', 0, '#333333'], ['-dark', 1, '#e8e8e8']]; // suffix, tone index, colour without a tone
const SIZES = [['', 16], ['@2x', 32]];

async function render(win, svg, size) {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return win.webContents.executeJavaScript(`(async () => {
    const img = new Image(${size}, ${size});
    img.src = ${JSON.stringify(url)};
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ${size};
    canvas.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
    return canvas.toDataURL('image/png');
  })()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  for (const name of Object.keys(ICONS)) {
    for (const [suffix, toneIndex, plain] of VARIANTS) {
      const color = iconTone(name)?.[toneIndex] ?? plain;
      const svg = iconMarkup(name)
        .replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" color="${color}" `);
      for (const [scale, size] of SIZES) {
        const png = await render(win, svg, size);
        await fs.writeFile(path.join(OUT, `${name}${suffix}${scale}.png`), Buffer.from(png.split(',')[1], 'base64'));
      }
    }
  }
  console.log(`Wrote ${Object.keys(ICONS).length} icons to ${path.relative(process.cwd(), OUT)}`);
  app.quit();
});
