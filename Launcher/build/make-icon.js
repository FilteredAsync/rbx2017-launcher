'use strict';

// Draws the launcher's icon and writes build/icon.ico (16-256 px, used for the
// app, Setup.exe and the uninstaller) and build/icon.png (512 px preview).
// A red classic studded brick on the launcher's dark blue, with its neon grid.
//
//   cd Launcher
//   npx electron build/make-icon.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

// Runs in the page: draws the icon at every size, returns PNG data URLs.
function render(sizes) {
  const ISO_X = [0.866, 0.5];   // isometric axes
  const ISO_Y = [-0.866, 0.5];

  function draw(ctx, detailed, small) {
    // Everything is drawn on a 256 x 256 grid and scaled.
    const round = 50;
    const box = new Path2D();
    box.roundRect(8, 8, 240, 240, round);

    // Background: the launcher's deep blue.
    const sky = ctx.createLinearGradient(0, 8, 0, 248);
    sky.addColorStop(0, '#0f3a63');
    sky.addColorStop(0.55, '#0a2440');
    sky.addColorStop(1, '#061322');
    ctx.fillStyle = sky;
    ctx.fill(box);

    ctx.save();
    ctx.clip(box);
    // Soft light behind the brick.
    const halo = ctx.createRadialGradient(128, 120, 10, 128, 120, 150);
    halo.addColorStop(0, 'rgba(60, 170, 255, 0.45)');
    halo.addColorStop(1, 'rgba(60, 170, 255, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, 256, 256);
    if (detailed) {
      // The neon grid of the launcher's background.
      ctx.lineCap = 'round';
      for (const [x1, y1, x2, y2, alpha] of [[-20, 70, 276, 30, 0.55], [-20, 214, 276, 236, 0.35], [70, -20, 40, 276, 0.3], [212, -20, 236, 276, 0.45]]) {
        ctx.strokeStyle = `rgba(0, 162, 255, ${alpha * 0.35})`;
        ctx.lineWidth = 10;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.strokeStyle = `rgba(150, 215, 255, ${alpha})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    }
    // Shadow under the brick.
    const shadow = ctx.createRadialGradient(128, 214, 4, 128, 214, 92);
    shadow.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
    shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shadow;
    ctx.beginPath(); ctx.ellipse(128, 212, 100, 30, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // The brick: 2 x 2 studs, isometric. Tiny icons (16, 24 px) get a larger
    // brick so it still reads as one.
    ctx.save();
    if (small) {
      ctx.translate(128, 140);
      ctx.scale(1.22, 1.22);
      ctx.translate(-128, -146);
    }
    const cx = 128;
    const cy = 162;
    const half = 50;
    const height = 58;
    const at = (x, y, z) => [cx + ISO_X[0] * x + ISO_Y[0] * y, cy + ISO_X[1] * x + ISO_Y[1] * y - z];
    const face = (points, fill, stroke) => {
      ctx.beginPath();
      points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
    };
    const back = (z) => at(-half, -half, z);
    const right = (z) => at(half, -half, z);
    const front = (z) => at(half, half, z);
    const left = (z) => at(-half, half, z);

    const leftFace = ctx.createLinearGradient(...left(0), ...front(0));
    leftFace.addColorStop(0, '#c41e16');
    leftFace.addColorStop(1, '#d9271e');
    face([left(height), front(height), front(0), left(0)], leftFace, 'rgba(40, 0, 0, 0.55)');
    const rightFace = ctx.createLinearGradient(...front(0), ...right(0));
    rightFace.addColorStop(0, '#9e130d');
    rightFace.addColorStop(1, '#7d0e09');
    face([front(height), right(height), right(0), front(0)], rightFace, 'rgba(40, 0, 0, 0.55)');
    const top = ctx.createLinearGradient(...back(height), ...front(height));
    top.addColorStop(0, '#ff6b5f');
    top.addColorStop(1, '#f2382c');
    face([back(height), right(height), front(height), left(height)], top, 'rgba(40, 0, 0, 0.55)');
    // Light along the top edges.
    ctx.strokeStyle = 'rgba(255, 220, 215, 0.55)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(...left(height)); ctx.lineTo(...front(height)); ctx.lineTo(...right(height));
    ctx.stroke();

    // Studs, back to front.
    const studRadius = 15.5;
    const studHeight = 11;
    const rx = studRadius * 1.2247;
    const ry = studRadius * 0.7071;
    for (const [x, y] of [[-22, -22], [22, -22], [-22, 22], [22, 22]]) {
      const [sx, sy] = at(x, y, height);
      // Side of the stud.
      const side = ctx.createLinearGradient(sx - rx, 0, sx + rx, 0);
      side.addColorStop(0, '#d32a20');
      side.addColorStop(0.6, '#b81a12');
      side.addColorStop(1, '#8f100a');
      ctx.fillStyle = side;
      ctx.beginPath();
      ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI);
      ctx.lineTo(sx - rx, sy - studHeight);
      ctx.ellipse(sx, sy - studHeight, rx, ry, 0, Math.PI, 0, true);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(40, 0, 0, 0.45)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // Top of the stud.
      const cap = ctx.createRadialGradient(sx - rx * 0.35, sy - studHeight - ry * 0.4, 1, sx, sy - studHeight, rx);
      cap.addColorStop(0, '#ff9a8f');
      cap.addColorStop(1, '#f2443a');
      ctx.fillStyle = cap;
      ctx.beginPath();
      ctx.ellipse(sx, sy - studHeight, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // Rim of the tile.
    ctx.strokeStyle = 'rgba(0, 162, 255, 0.55)';
    ctx.lineWidth = 5;
    ctx.stroke(box);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke(box);
  }

  const out = {};
  for (const size of sizes) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.scale(size / 256, size / 256);
    draw(ctx, size >= 48, size <= 24);
    out[size] = canvas.toDataURL('image/png');
  }
  return out;
}

// An .ico holding PNG images (Windows Vista and later read these).
function icoFromPngs(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((png) => png.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<!doctype html><title>icon</title>');
  const images = await win.webContents.executeJavaScript(`(${render.toString()})(${JSON.stringify([...SIZES, 512])})`);
  const png = (size) => Buffer.from(images[size].split(',')[1], 'base64');
  const ico = icoFromPngs(SIZES.map((size) => ({ size, data: png(size) })));
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico);
  fs.writeFileSync(path.join(__dirname, 'icon.png'), png(512));
  console.log(`wrote build/icon.ico (${SIZES.join(', ')} px) and build/icon.png (512 px)`);
  app.quit();
});
