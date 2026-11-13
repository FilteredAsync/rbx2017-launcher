'use strict';

// Animated menu backdrop, drawn on a canvas: dusk sky with stars and aurora
// bands, light rays, three voxel mountain ranges with parallax, and studded
// bricks floating at different depths. All shapes are drawn here (no image
// files). It pauses while the window is hidden or the game is running
// (window.backgroundPaused), and keeps to about 40 frames a second.

(function () {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let dpr = 1;

  // Small seeded random, so the mountains look the same every start.
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  window.addEventListener('mousemove', (event) => {
    mouse.tx = (event.clientX / window.innerWidth - 0.5) * 2;
    mouse.ty = (event.clientY / window.innerHeight - 0.5) * 2;
  });

  // --- static layers --------------------------------------------------------

  const stars = [];
  for (let i = 0; i < 170; i++) {
    stars.push({ x: rand(), y: rand() * 0.62, r: 0.4 + rand() * 1.3, phase: rand() * Math.PI * 2, speed: 0.6 + rand() * 1.8 });
  }

  // Voxel ridge: a skyline of stepped columns, repeated horizontally.
  function makeRange(count, minH, maxH, roughness) {
    const columns = [];
    let h = minH + rand() * (maxH - minH);
    for (let i = 0; i < count; i++) {
      h += (rand() - 0.5) * roughness;
      if (rand() < 0.08) h += (maxH - minH) * 0.35; // a peak
      h = Math.max(minH, Math.min(maxH, h));
      columns.push(h);
    }
    return columns;
  }
  const ranges = [
    { columns: makeRange(64, 0.14, 0.34, 0.07), color: ['#2b3b6b', '#1b2648'], speed: 4, parallax: 10, top: '#46609e' },
    { columns: makeRange(52, 0.09, 0.25, 0.08), color: ['#1c2850', '#121a36'], speed: 8, parallax: 22, top: '#33497e' },
    { columns: makeRange(40, 0.04, 0.15, 0.09), color: ['#111833', '#0a0f22'], speed: 14, parallax: 40, top: '#26375f' },
  ];

  const BRICK_COLORS = [
    ['#e2231a', '#b81c15', '#8f150f'], // bright red
    ['#0d69ac', '#0a5288', '#073c64'], // bright blue
    ['#f5cd30', '#d6b021', '#a88a17'], // bright yellow
    ['#4b974b', '#3a773a', '#2a582a'], // bright green
    ['#f2f3f3', '#c9cacb', '#9c9d9e'], // white
  ];
  const bricks = [];
  function newBrick(anywhere) {
    const z = 0.25 + rand() * 0.75; // depth: small = far
    return {
      x: rand(),
      y: anywhere ? rand() : 1.08 + rand() * 0.2,
      z,
      size: 18 + z * 46,
      studsX: 1 + Math.floor(rand() * 3),
      studsY: 1 + Math.floor(rand() * 2),
      color: BRICK_COLORS[Math.floor(rand() * BRICK_COLORS.length)],
      rise: 0.006 + rand() * 0.012,
      sway: rand() * Math.PI * 2,
      spin: (rand() - 0.5) * 0.25,
      angle: (rand() - 0.5) * 0.6,
    };
  }
  for (let i = 0; i < 16; i++) bricks.push(newBrick(true));
  bricks.sort((a, b) => a.z - b.z);

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  window.addEventListener('resize', resize);
  resize();

  // --- drawing --------------------------------------------------------------

  function sky(t) {
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, '#060a1c');
    g.addColorStop(0.45, '#14204a');
    g.addColorStop(0.72, '#3a2f6e');
    g.addColorStop(0.86, '#a24a62');
    g.addColorStop(1, '#f08a4b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    // Sun just above the ridges, with a wide warm glow.
    const sx = width * 0.66 + mouse.x * 8;
    const sy = height * 0.64;
    const sun = ctx.createRadialGradient(sx, sy, 0, sx, sy, height * 0.7);
    sun.addColorStop(0, 'rgba(255, 226, 170, 0.95)');
    sun.addColorStop(0.06, 'rgba(255, 190, 120, 0.7)');
    sun.addColorStop(0.22, 'rgba(255, 120, 90, 0.32)');
    sun.addColorStop(0.55, 'rgba(160, 80, 140, 0.12)');
    sun.addColorStop(1, 'rgba(160, 80, 140, 0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, width, height);

    // Light rays fanning up from the sun.
    ctx.save();
    ctx.translate(sx, sy);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI / 2 + (i - 4) * 0.2 + Math.sin(t * 0.15 + i) * 0.04;
      ctx.rotate(0);
      const len = height * 1.1;
      const spread = 0.035 + (i % 3) * 0.012;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a - spread) * len, Math.sin(a - spread) * len);
      ctx.lineTo(Math.cos(a + spread) * len, Math.sin(a + spread) * len);
      ctx.closePath();
      const ray = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
      const alpha = 0.09 + 0.06 * Math.sin(t * 0.4 + i * 1.7);
      ray.addColorStop(0, `rgba(255, 210, 150, ${alpha})`);
      ray.addColorStop(1, 'rgba(255, 210, 150, 0)');
      ctx.fillStyle = ray;
      ctx.fill();
    }
    ctx.restore();
  }

  function starfield(t) {
    for (const s of stars) {
      const twinkle = 0.45 + 0.55 * Math.sin(t * s.speed + s.phase);
      ctx.globalAlpha = Math.max(0, twinkle) * (1 - s.y * 1.2);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(s.x * width - mouse.x * 4, s.y * height - mouse.y * 3, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function aurora(t) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let band = 0; band < 3; band++) {
      ctx.beginPath();
      const base = height * (0.18 + band * 0.07);
      ctx.moveTo(0, base);
      for (let x = 0; x <= width; x += 24) {
        const y = base + Math.sin(x * 0.004 + t * (0.25 + band * 0.07) + band) * 34 + Math.sin(x * 0.011 - t * 0.3) * 12;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, base + 140);
      ctx.lineTo(0, base + 140);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, base - 40, 0, base + 140);
      const hue = band === 1 ? '90, 140, 255' : '80, 220, 200';
      g.addColorStop(0, `rgba(${hue}, 0)`);
      g.addColorStop(0.35, `rgba(${hue}, ${0.07 - band * 0.015})`);
      g.addColorStop(1, `rgba(${hue}, 0)`);
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.restore();
  }

  function mountains(t) {
    ranges.forEach((range, layer) => {
      if (layer > 0) {
        // Warm haze between layers, so the ranges read as far and near.
        const haze = ctx.createLinearGradient(0, height * 0.5, 0, height);
        haze.addColorStop(0, 'rgba(240, 130, 110, 0)');
        haze.addColorStop(1, `rgba(240, 130, 110, ${0.1 - layer * 0.03})`);
        ctx.fillStyle = haze;
        ctx.fillRect(0, 0, width, height);
      }
      const colWidth = Math.max(18, width / 26);
      const total = range.columns.length * colWidth;
      const offset = ((t * range.speed) % total) + mouse.x * range.parallax;
      const g = ctx.createLinearGradient(0, height * 0.45, 0, height);
      g.addColorStop(0, range.color[0]);
      g.addColorStop(1, range.color[1]);
      for (let pass = -1; pass <= Math.ceil(width / total) + 1; pass++) {
        range.columns.forEach((h, i) => {
          const x = pass * total + i * colWidth - offset;
          if (x > width || x + colWidth < 0) return;
          const step = Math.round(h * height / 12) * 12; // voxel steps
          const y = height - step - mouse.y * range.parallax * 0.3;
          ctx.fillStyle = g;
          ctx.fillRect(Math.floor(x), Math.floor(y), Math.ceil(colWidth) + 1, height - y + 2);
          ctx.fillStyle = range.top; // lit top edge of each voxel column
          ctx.fillRect(Math.floor(x), Math.floor(y), Math.ceil(colWidth) + 1, 3);
        });
      }
    });
  }

  function brick(b, t) {
    const s = b.size;
    const w = s * (0.7 + b.studsX * 0.35);
    const d = s * (0.5 + b.studsY * 0.3);
    const h = s * 0.55;
    const x = b.x * width - mouse.x * 30 * b.z;
    const y = b.y * height - mouse.y * 20 * b.z;
    ctx.save();
    ctx.translate(x + Math.sin(t * 0.5 + b.sway) * 14 * b.z, y);
    ctx.rotate(b.angle + Math.sin(t * b.spin + b.sway) * 0.25);
    ctx.globalAlpha = 0.35 + b.z * 0.6;
    const [top, left, right] = b.color;
    // Isometric box: top, left and right faces.
    const iso = (px, py, pz) => [(px - py) * 0.866, (px + py) * 0.5 - pz];
    const P = (px, py, pz) => iso(px - w / 2, py - d / 2, pz);
    const poly = (points, color) => {
      ctx.beginPath();
      points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    poly([P(0, d, 0), P(w, d, 0), P(w, d, h), P(0, d, h)], left);
    poly([P(w, 0, 0), P(w, d, 0), P(w, d, h), P(w, 0, h)], right);
    poly([P(0, 0, h), P(w, 0, h), P(w, d, h), P(0, d, h)], top);
    // Studs on top.
    const studR = s * 0.13;
    for (let i = 0; i < b.studsX; i++) {
      for (let j = 0; j < b.studsY; j++) {
        const [cx, cy] = P((i + 0.5) * w / b.studsX, (j + 0.5) * d / b.studsY, h);
        ctx.fillStyle = left;
        ctx.beginPath();
        ctx.ellipse(cx, cy - studR * 0.25, studR, studR * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = top;
        ctx.beginPath();
        ctx.ellipse(cx, cy - studR * 0.6, studR, studR * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function vignette() {
    const g = ctx.createRadialGradient(width / 2, height * 0.45, height * 0.25, width / 2, height * 0.5, height * 0.95);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0.4)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    // Slightly darker band on the left, where the menu text sits.
    const side = ctx.createLinearGradient(0, 0, width * 0.45, 0);
    side.addColorStop(0, 'rgba(6, 10, 24, 0.38)');
    side.addColorStop(1, 'rgba(6, 10, 24, 0)');
    ctx.fillStyle = side;
    ctx.fillRect(0, 0, width, height);
  }

  // --- neon grid (the default) ---------------------------------------------------
  // Dark textured blue, like a stone wall in the dark, with a lattice of
  // glowing blue beams receding to the right and light pulses along them.

  let texture = null;
  function buildTexture() {
    texture = document.createElement('canvas');
    texture.width = Math.max(1, Math.round(width));
    texture.height = Math.max(1, Math.round(height));
    const t = texture.getContext('2d');
    const base = t.createLinearGradient(0, 0, width, height);
    base.addColorStop(0, '#1b3446');
    base.addColorStop(0.5, '#132836');
    base.addColorStop(1, '#0b1822');
    t.fillStyle = base;
    t.fillRect(0, 0, width, height);
    // Soft blotches and speckles for a rough, rocky surface.
    for (let i = 0; i < 60; i++) {
      const x = rand() * width;
      const y = rand() * height;
      const r = 40 + rand() * 220;
      const g = t.createRadialGradient(x, y, 0, x, y, r);
      const light = rand() < 0.5;
      g.addColorStop(0, light ? 'rgba(80, 130, 160, 0.10)' : 'rgba(0, 0, 0, 0.18)');
      g.addColorStop(1, 'rgba(0, 0, 0, 0)');
      t.fillStyle = g;
      t.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const speckles = Math.round(width * height / 260);
    for (let i = 0; i < speckles; i++) {
      t.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.12)';
      t.fillRect(rand() * width, rand() * height, 1 + rand() * 2, 1 + rand() * 2);
    }
  }

  const BEAM_SPACING = 2.4;
  const beams = [];
  for (let i = 0; i <= 6; i++) beams.push({ kind: 'v', at: i * BEAM_SPACING });
  for (let j = -1; j <= 3; j++) beams.push({ kind: 'h', at: j * BEAM_SPACING });
  const pulses = [];
  for (let i = 0; i < 7; i++) pulses.push({ beam: Math.floor(rand() * beams.length), pos: rand(), speed: 0.05 + rand() * 0.08 });
  const dust = [];
  for (let i = 0; i < 70; i++) dust.push({ x: rand(), y: rand(), z: 0.3 + rand() * 0.7, drift: rand() * Math.PI * 2 });

  // The lattice lies on a wall that recedes to the right; project it.
  function project(X, Y, cam) {
    const z = 3.2 + X * 0.42;
    const f = width * 0.62;
    return [width * 0.5 + (X - cam.x) * f / z, height * 0.3 - (Y - cam.y) * f / z, f / z];
  }

  function beamPath(beam, cam, from = 0, to = 1) {
    const span = beam.kind === 'v' ? [-BEAM_SPACING * 1.5, BEAM_SPACING * 4] : [0, BEAM_SPACING * 6];
    const a = span[0] + (span[1] - span[0]) * from;
    const b = span[0] + (span[1] - span[0]) * to;
    const p1 = beam.kind === 'v' ? project(beam.at, a, cam) : project(a, beam.at, cam);
    const p2 = beam.kind === 'v' ? project(beam.at, b, cam) : project(b, beam.at, cam);
    return [p1, p2];
  }

  function drawNeon(t, dt) {
    if (!texture || texture.width !== Math.round(width) || texture.height !== Math.round(height)) buildTexture();
    ctx.drawImage(texture, 0, 0, width, height);

    const cam = { x: Math.sin(t * 0.05) * 0.5 + mouse.x * 0.35, y: Math.cos(t * 0.04) * 0.3 - mouse.y * 0.25 };
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'square';
    const breathe = 0.85 + 0.15 * Math.sin(t * 0.7);
    // Three passes per beam: wide haze, glow, bright core.
    const passes = [[26, 0.05], [11, 0.16], [3.2, 0.75]];
    for (const [w, alpha] of passes) {
      for (const beam of beams) {
        const [[x1, y1, s1], [x2, y2]] = beamPath(beam, cam);
        ctx.strokeStyle = w < 5 ? `rgba(150, 215, 255, ${alpha * breathe})` : `rgba(30, 140, 255, ${alpha * breathe})`;
        ctx.lineWidth = Math.max(1, w * s1 / 260);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }
    // Light pulses running along the beams.
    for (const pulse of pulses) {
      pulse.pos += pulse.speed * dt;
      if (pulse.pos > 1) { pulse.pos = 0; pulse.beam = Math.floor(rand() * beams.length); }
      const [[x1, y1, s1], [x2, y2]] = beamPath(beams[pulse.beam], cam);
      const x = x1 + (x2 - x1) * pulse.pos;
      const y = y1 + (y2 - y1) * pulse.pos;
      const r = Math.max(6, 40 * s1 / 260);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(210, 240, 255, 0.9)');
      g.addColorStop(0.3, 'rgba(60, 170, 255, 0.35)');
      g.addColorStop(1, 'rgba(60, 170, 255, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // Glow the lattice casts on the wall.
    const glow = ctx.createRadialGradient(width * 0.72, height * 0.2, 0, width * 0.72, height * 0.2, width * 0.55);
    glow.addColorStop(0, `rgba(30, 120, 220, ${0.16 * breathe})`);
    glow.addColorStop(1, 'rgba(30, 120, 220, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    // Dust drifting through the light.
    for (const d of dust) {
      d.y -= 0.004 * dt * d.z;
      d.x += Math.sin(t * 0.3 + d.drift) * 0.0004 * d.z;
      if (d.y < -0.02) { d.y = 1.02; d.x = rand(); }
      ctx.fillStyle = `rgba(160, 210, 255, ${0.12 + d.z * 0.25})`;
      ctx.fillRect(d.x * width - mouse.x * 12 * d.z, d.y * height, 1.5 * d.z + 0.5, 1.5 * d.z + 0.5);
    }
    ctx.restore();

    // Keep the left side, where the columns are, a little calmer.
    const side = ctx.createLinearGradient(0, 0, width * 0.55, 0);
    side.addColorStop(0, 'rgba(5, 14, 20, 0.45)');
    side.addColorStop(1, 'rgba(5, 14, 20, 0)');
    ctx.fillStyle = side;
    ctx.fillRect(0, 0, width, height);
    const v = ctx.createRadialGradient(width / 2, height / 2, height * 0.3, width / 2, height / 2, height * 1.0);
    v.addColorStop(0, 'rgba(0, 0, 0, 0)');
    v.addColorStop(1, 'rgba(0, 0, 0, 0.5)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, width, height);
  }

  // --- sunset (the alternative) ------------------------------------------------------

  function drawSunset(t, dt) {
    sky(t);
    starfield(t);
    aurora(t);
    // Far bricks behind the mountains, near bricks in front.
    for (const b of bricks) {
      b.y -= b.rise * dt * (0.6 + b.z);
      if (b.y < -0.15) Object.assign(b, newBrick(false));
    }
    bricks.filter((b) => b.z < 0.5).forEach((b) => brick(b, t));
    mountains(t);
    bricks.filter((b) => b.z >= 0.5).forEach((b) => brick(b, t));
    vignette();
  }

  // Classic: the console app's calm dark blue, with soft light sweeping
  // across and a few faint squares drifting up (the default).
  const squares = [];
  for (let i = 0; i < 16; i++) {
    squares.push({ x: rand(), y: rand(), size: 40 + rand() * 150, speed: 0.004 + rand() * 0.01, spin: (rand() - 0.5) * 0.2, angle: rand() * Math.PI, alpha: 0.025 + rand() * 0.05 });
  }
  function drawClassic(t, dt) {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#153049');
    sky.addColorStop(0.55, '#0f2335');
    sky.addColorStop(1, '#0a1824');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);
    // A wide glow drifting slowly from side to side.
    const gx = width * (0.55 + Math.sin(t * 0.07) * 0.18) + mouse.x * 30;
    const gy = height * (0.3 + Math.cos(t * 0.05) * 0.06) + mouse.y * 20;
    const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(width, height) * 0.65);
    glow.addColorStop(0, 'rgba(56, 132, 196, 0.32)');
    glow.addColorStop(0.5, 'rgba(30, 80, 130, 0.12)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    // Diagonal light bands.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const offset = ((t * (8 + i * 5)) % (width + height)) - height;
      const band = ctx.createLinearGradient(offset, 0, offset + height * 0.6, height);
      band.addColorStop(0, 'rgba(255, 255, 255, 0)');
      band.addColorStop(0.5, `rgba(120, 190, 255, ${0.025 + i * 0.008})`);
      band.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = band;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.restore();
    for (const square of squares) {
      square.y -= square.speed * dt;
      square.angle += square.spin * dt;
      if (square.y < -0.25) { square.y = 1.15; square.x = rand(); }
      ctx.save();
      ctx.translate(square.x * width + mouse.x * square.size * 0.1, square.y * height + mouse.y * square.size * 0.1);
      ctx.rotate(square.angle);
      ctx.strokeStyle = `rgba(160, 210, 255, ${square.alpha * 2})`;
      ctx.fillStyle = `rgba(120, 180, 240, ${square.alpha})`;
      ctx.lineWidth = 2;
      ctx.fillRect(-square.size / 2, -square.size / 2, square.size, square.size);
      ctx.strokeRect(-square.size / 2, -square.size / 2, square.size, square.size);
      ctx.restore();
    }
    const shade = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.3, width / 2, height / 2, Math.max(width, height) * 0.75);
    shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
    shade.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);
  }

  try { window.backgroundMode = localStorage.getItem('background') || 'classic'; } catch (error) { window.backgroundMode = 'classic'; }

  let last = 0;
  let clock = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden || window.backgroundPaused) { last = now; return; }
    if (now - last < 24) return; // ~40 fps
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    clock += dt;
    mouse.x += (mouse.tx - mouse.x) * 0.05;
    mouse.y += (mouse.ty - mouse.y) * 0.05;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (window.backgroundMode === 'sunset') drawSunset(clock, dt);
    else if (window.backgroundMode === 'neon') drawNeon(clock, dt);
    else drawClassic(clock, dt);
  }
  requestAnimationFrame(frame);
}());
