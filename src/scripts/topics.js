// Conversation starters for the contact section. Renders CONTENT.talk into
// every [data-topics] element (replacing the plain list the HTML ships for
// readers without JavaScript): a short sub line, topic chips in two groups,
// and, for the picked topic, a tiny looping animation, a starter line and a
// "Start here" email link. Styles live in src/styles/topics.css and canvas
// colors come from the shared tokens. Ported from the mockup's topics.js.
import { CONTENT } from "../data/content";
import { mailto } from "./email";

const C = CONTENT;
const T = C.talk;

const SW = 168, SH = 96; // animation stage, CSS px
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ===== small helpers =====
const rnd = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.floor(rnd(a, b + 1));
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
function box(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}
function dot(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }
function brackets(ctx, x, y, s) {
  const k = s * 0.45;
  ctx.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    ctx.moveTo(x + sx * s, y + sy * s - sy * k);
    ctx.lineTo(x + sx * s, y + sy * s);
    ctx.lineTo(x + sx * s - sx * k, y + sy * s);
  }
  ctx.stroke();
}
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n, f) => cs.getPropertyValue(n).trim() || f;
  return {
    accent: g("--accent", "#A594FF"), accent2: g("--accent-2", "#6FE3D0"), ink: g("--ink", "#EEF0FF"),
    muted: g("--muted", "#9AA0C0"), line: g("--line", "#2A3150"), accentInk: g("--accent-ink", "#0A0F24"),
    mono: g("--font-mono", "monospace"),
  };
}

// ===== scenes: each returns { step(dt), draw(ctx, colors) } =====
const SCENES = {
  // A live schedule: time scrolls left past a "now" line, new jobs fly in
  // and land on whichever robot row frees up first.
  scheduling() {
    const rows = 4, top = 24, rowH = 17, left = 24, nowX = 70, speed = 16;
    const lanes = [[], [], [], []];
    let spawn = 0.3;
    const flying = [];
    const laneEnd = (r) => lanes[r].reduce((m, b) => Math.max(m, b.x + b.w), nowX - 8);
    for (let r = 0; r < rows; r++) {
      let x = left + rnd(-14, 6);
      while (x < SW - 26) { const w = rnd(12, 30); lanes[r].push({ x, w, fresh: 0 }); x += w + 3; }
    }
    return {
      step(dt) {
        for (const lane of lanes) {
          for (const b of lane) { b.x -= speed * dt; if (b.fresh > 0) b.fresh -= dt; }
          while (lane.length && lane[0].x + lane[0].w < left - 4) lane.shift();
        }
        for (let i = flying.length - 1; i >= 0; i--) {
          const f = flying[i];
          f.t += dt / 0.45; f.tx -= speed * dt;
          if (f.t >= 1) { lanes[f.r].push({ x: f.tx, w: f.w, fresh: 0.7 }); flying.splice(i, 1); }
        }
        spawn -= dt;
        if (spawn > 0) return;
        spawn = rnd(0.35, 0.6);
        let best = 0, bestEnd = Infinity;
        for (let r = 0; r < rows; r++) {
          const pending = flying.filter((f) => f.r === r).reduce((m, f) => Math.max(m, f.tx + f.w), 0);
          const e = Math.max(laneEnd(r), pending);
          if (e < bestEnd) { bestEnd = e; best = r; }
        }
        if (bestEnd < SW - 30) {
          const w = rnd(12, 30);
          flying.push({ r: best, w, tx: Math.max(bestEnd + 3, nowX - 4), t: 0, sx: SW - w - 6, sy: 4 });
        }
      },
      draw(ctx, c) {
        ctx.font = `500 8px ${c.mono}`;
        ctx.textBaseline = "middle";
        for (let r = 0; r < rows; r++) {
          const y = top + r * rowH;
          ctx.fillStyle = c.muted; ctx.fillText("R" + (r + 1), 6, y + 6);
          ctx.strokeStyle = c.line; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(left, y + 5.5); ctx.lineTo(SW - 4, y + 5.5); ctx.stroke();
        }
        ctx.save();
        ctx.beginPath(); ctx.rect(left, 0, SW - left - 2, SH); ctx.clip();
        for (let r = 0; r < rows; r++) {
          const y = top + r * rowH;
          for (const b of lanes[r]) {
            const done = b.x + b.w < nowX, active = !done && b.x <= nowX;
            box(ctx, b.x, y, b.w, 11, 2);
            if (done) { ctx.globalAlpha = 0.28; ctx.fillStyle = c.muted; ctx.fill(); }
            else if (active) { ctx.globalAlpha = 1; ctx.fillStyle = c.accent; ctx.fill(); }
            else {
              ctx.globalAlpha = 0.16; ctx.fillStyle = c.accent; ctx.fill();
              ctx.globalAlpha = 0.9; ctx.strokeStyle = b.fresh > 0 ? c.accent2 : c.accent; ctx.lineWidth = 1; ctx.stroke();
            }
          }
        }
        ctx.restore();
        ctx.globalAlpha = 1;
        for (const f of flying) {
          const t = ease(clamp01(f.t));
          box(ctx, lerp(f.sx, f.tx, t), lerp(f.sy, top + f.r * rowH, t), f.w, 11, 2);
          ctx.fillStyle = c.accent2; ctx.fill();
        }
        ctx.strokeStyle = c.accent2; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(nowX, top - 6); ctx.lineTo(nowX, top + rows * rowH - 3); ctx.stroke();
        ctx.fillStyle = c.accent2; ctx.fillText("now", nowX + 4, top - 9);
      },
    };
  },

  // Robots on a grid, each heading to its order along an L-shaped path,
  // waiting rather than colliding when the next cell is taken.
  fleets() {
    const cols = 9, rows = 5, cell = 16;
    const ox = (SW - cols * cell) / 2, oy = (SH - rows * cell) / 2;
    const cx = (i) => ox + i * cell + cell / 2, cy = (j) => oy + j * cell + cell / 2;
    const bots = [];
    const taken = (x, y, self) => bots.some((b) => b !== self && ((b.x === x && b.y === y) || (b.nx === x && b.ny === y)));
    const freeCell = (self) => {
      for (let k = 0; k < 60; k++) {
        const x = ri(0, cols - 1), y = ri(0, rows - 1);
        if (!taken(x, y, null) && !bots.some((b) => b !== self && b.tx === x && b.ty === y)) return [x, y];
      }
      return [0, 0];
    };
    for (let k = 0; k < 4; k++) {
      const [x, y] = freeCell(null);
      bots.push({ x, y, nx: x, ny: y, p: 1, tx: -1, ty: -1, flash: 0, wait: 0, blocked: 0 });
    }
    for (const b of bots) [b.tx, b.ty] = freeCell(b);
    const pos = (b) => [lerp(cx(b.x), cx(b.nx), b.p), lerp(cy(b.y), cy(b.ny), b.p)];
    return {
      step(dt) {
        for (const b of bots) {
          if (b.flash > 0) b.flash -= dt;
          if (b.p < 1) { b.p = Math.min(1, b.p + dt * 3.4); if (b.p >= 1) { b.x = b.nx; b.y = b.ny; } continue; }
          if (b.x === b.tx && b.y === b.ty) { b.flash = 0.5; b.wait = 0.35; [b.tx, b.ty] = freeCell(b); continue; }
          if (b.wait > 0) { b.wait -= dt; continue; }
          const opts = [];
          if (b.x !== b.tx) opts.push([b.x + Math.sign(b.tx - b.x), b.y]);
          if (b.y !== b.ty) opts.push([b.x, b.y + Math.sign(b.ty - b.y)]);
          const next = opts.find(([x, y]) => !taken(x, y, b));
          if (next) { b.nx = next[0]; b.ny = next[1]; b.p = 0; b.blocked = 0; }
          else if ((b.blocked += dt) > 1.2) { [b.tx, b.ty] = freeCell(b); b.blocked = 0; }
        }
      },
      draw(ctx, c) {
        ctx.strokeStyle = c.line; ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i <= cols; i++) { const x = Math.round(ox + i * cell) + 0.5; ctx.moveTo(x, oy); ctx.lineTo(x, oy + rows * cell); }
        for (let j = 0; j <= rows; j++) { const y = Math.round(oy + j * cell) + 0.5; ctx.moveTo(ox, y); ctx.lineTo(ox + cols * cell, y); }
        ctx.stroke();
        for (const b of bots) {
          const [px, py] = pos(b);
          ctx.setLineDash([2, 3]); ctx.strokeStyle = c.accent2; ctx.globalAlpha = 0.6;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(cx(b.tx), py); ctx.lineTo(cx(b.tx), cy(b.ty)); ctx.stroke();
          ctx.setLineDash([]);
          box(ctx, cx(b.tx) - 5, cy(b.ty) - 5, 10, 10, 2);
          ctx.globalAlpha = 0.25; ctx.fillStyle = c.accent; ctx.fill();
          ctx.globalAlpha = 1; ctx.strokeStyle = c.accent; ctx.stroke();
        }
        for (const b of bots) {
          const [px, py] = pos(b);
          if (b.flash > 0) {
            ctx.globalAlpha = b.flash / 0.5; ctx.strokeStyle = c.accent2; ctx.lineWidth = 1.2;
            dot(ctx, px, py, 7 + (0.5 - b.flash) * 18); ctx.stroke();
          }
          ctx.globalAlpha = 1; ctx.fillStyle = c.ink; box(ctx, px - 5.5, py - 5.5, 11, 11, 2.5); ctx.fill();
          ctx.fillStyle = c.accent; box(ctx, px - 2.5, py - 2.5, 5, 5, 1); ctx.fill();
        }
      },
    };
  },

  // Six services on an event bus. One by one each soft "py" node snaps into
  // a crisp "rs" node, and events through migrated nodes move faster.
  rust() {
    const busY = SH / 2, xs = [34, 84, 134];
    const nodes = [];
    xs.forEach((x) => { nodes.push({ x, y: 18, s: 0, m: 0, flash: 0 }); nodes.push({ x, y: SH - 18, s: 0, m: 0, flash: 0 }); });
    let next = 1.0, hold = 0, time = 0;
    let pulses = [];
    const route = (p) => [[p.a.x, p.a.y], [p.a.x, busY], [p.b.x, busY], [p.b.x, p.b.y]];
    const along = (pts, d) => {
      for (let k = 0; k < pts.length - 1; k++) {
        const [x0, y0] = pts[k], [x1, y1] = pts[k + 1], len = Math.hypot(x1 - x0, y1 - y0);
        if (d <= len) return [lerp(x0, x1, d / len), lerp(y0, y1, d / len)];
        d -= len;
      }
      return null;
    };
    return {
      step(dt) {
        time += dt;
        for (const n of nodes) { n.m += (n.s - n.m) * Math.min(1, dt * 7); if (n.flash > 0) n.flash -= dt; }
        if (hold > 0) {
          hold -= dt;
          if (hold <= 0) { nodes.forEach((n) => { n.s = 0; }); next = 1.2; }
        } else if ((next -= dt) <= 0) {
          const py = nodes.filter((n) => n.s === 0);
          if (py.length) { const n = py[ri(0, py.length - 1)]; n.s = 1; n.flash = 0.6; }
          next = 1.0;
          if (py.length <= 1) hold = 2.2;
        }
        if (Math.random() < dt * 8) {
          const a = nodes[ri(0, 5)];
          const b = nodes[(nodes.indexOf(a) + ri(1, 5)) % 6];
          pulses.push({ a, b, d: 0 });
        }
        for (const p of pulses) p.d += dt * (p.a.s && p.b.s ? 160 : 55);
        pulses = pulses.filter((p) => along(route(p), p.d));
      },
      draw(ctx, c) {
        ctx.strokeStyle = c.line; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(12, busY); ctx.lineTo(SW - 12, busY);
        for (const n of nodes) { ctx.moveTo(n.x, n.y); ctx.lineTo(n.x, busY); }
        ctx.stroke();
        for (const p of pulses) {
          const at = along(route(p), p.d);
          if (!at) continue;
          ctx.globalAlpha = 1; ctx.fillStyle = p.a.s && p.b.s ? c.accent2 : c.muted;
          dot(ctx, at[0], at[1], 1.8); ctx.fill();
        }
        ctx.font = `600 7px ${c.mono}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        nodes.forEach((n, k) => {
          const m = n.m;
          if (m < 0.99) {
            ctx.globalAlpha = 0.45 * (1 - m); ctx.fillStyle = c.muted;
            for (let j = 0; j < 3; j++) {
              const a = time * 2.2 + j * 2.1 + k;
              dot(ctx, n.x + Math.cos(a) * 2.2, n.y + Math.sin(a * 1.3) * 2.2, 6.5); ctx.fill();
            }
            ctx.globalAlpha = 1 - m; ctx.fillStyle = c.ink; ctx.fillText("py", n.x, n.y + 0.5);
          }
          if (m > 0.01) {
            const s = lerp(7, 15, m);
            ctx.globalAlpha = m; ctx.fillStyle = c.accent;
            box(ctx, n.x - s / 2, n.y - s / 2, s, s, lerp(6, 2.5, m)); ctx.fill();
            ctx.fillStyle = c.accentInk; ctx.fillText("rs", n.x, n.y + 0.5);
          }
          if (n.flash > 0) {
            ctx.globalAlpha = n.flash / 0.6; ctx.strokeStyle = c.accent2; ctx.lineWidth = 1.2;
            dot(ctx, n.x, n.y, 9 + (0.6 - n.flash) * 22); ctx.stroke();
          }
        });
        ctx.textAlign = "start";
      },
    };
  },

  // Recurring pattern discovery in one image: a scan box finds each repeat
  // of a motif among clutter, then the lattice that ties them together.
  ai() {
    const cols = 4, rows = 3, SCAN = 2.4, LAT = 1.0, HOLD = 1.4, FADE = 0.4;
    let motifs, noise, t, rot;
    const at = (i, j) => motifs[j * cols + i];
    function gen() {
      rot = rnd(-0.16, 0.16);
      const sk = rnd(-0.3, 0.3), sx = 32, sy = 23;
      const a = [Math.cos(rot) * sx, Math.sin(rot) * sx];
      const b = [-Math.sin(rot) * sy + sk * sy, Math.cos(rot) * sy];
      const w = a[0] * (cols - 1) + b[0] * (rows - 1), h = a[1] * (cols - 1) + b[1] * (rows - 1);
      const o = [SW / 2 - w / 2, SH / 2 - h / 2];
      motifs = [];
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) motifs.push({ x: o[0] + i * a[0] + j * b[0], y: o[1] + i * a[1] + j * b[1] });
      noise = Array.from({ length: 9 }, () => ({ x: rnd(8, SW - 8), y: rnd(8, SH - 8), r: rnd(0.8, 2.2) }));
      t = 0;
    }
    gen();
    return {
      step(dt) { t += dt; if (t > SCAN + LAT + HOLD + FADE) gen(); },
      draw(ctx, c) {
        const fade = t > SCAN + LAT + HOLD ? clamp01(1 - (t - SCAN - LAT - HOLD) / FADE) : 1;
        ctx.globalAlpha = 0.5 * fade; ctx.fillStyle = c.muted;
        for (const n of noise) { dot(ctx, n.x, n.y, n.r); ctx.fill(); }
        const found = Math.floor(clamp01(t / SCAN) * motifs.length);
        if (t > SCAN) {
          const lp = ease(clamp01((t - SCAN) / LAT));
          ctx.globalAlpha = 0.7 * fade; ctx.strokeStyle = c.accent2; ctx.lineWidth = 1;
          ctx.beginPath();
          for (let j = 0; j < rows; j++) { const p = at(0, j), q = at(cols - 1, j); ctx.moveTo(p.x, p.y); ctx.lineTo(lerp(p.x, q.x, lp), lerp(p.y, q.y, lp)); }
          for (let i = 0; i < cols; i++) { const p = at(i, 0), q = at(i, rows - 1); ctx.moveTo(p.x, p.y); ctx.lineTo(lerp(p.x, q.x, lp), lerp(p.y, q.y, lp)); }
          ctx.stroke();
        }
        motifs.forEach((m, k) => {
          const hit = k < found || t > SCAN;
          ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(rot + Math.PI / 4);
          ctx.globalAlpha = (hit ? 1 : 0.55) * fade; ctx.strokeStyle = c.ink; ctx.lineWidth = 1.2;
          ctx.strokeRect(-3.5, -3.5, 7, 7);
          ctx.restore();
          ctx.globalAlpha = (hit ? 1 : 0.55) * fade; ctx.fillStyle = c.ink; dot(ctx, m.x, m.y, 1.2); ctx.fill();
          if (hit) { ctx.globalAlpha = fade; ctx.strokeStyle = c.accent; ctx.lineWidth = 1.2; brackets(ctx, m.x, m.y, 7.5); }
        });
        if (t < SCAN) {
          const p = clamp01(t / SCAN) * (motifs.length - 1), k = Math.floor(p), f = p - k;
          const m0 = motifs[k], m1 = motifs[Math.min(motifs.length - 1, k + 1)];
          const x = lerp(m0.x, m1.x, ease(f)), y = lerp(m0.y, m1.y, ease(f));
          ctx.globalAlpha = 1; ctx.strokeStyle = c.accent2; ctx.lineWidth = 1.4;
          ctx.strokeRect(x - 10, y - 10, 20, 20);
        }
      },
    };
  },

  // Farm priority: gold drops, all five heroes reach for it, and it is
  // assigned by priority, so position 1 grows fastest.
  dota() {
    const gap = 26, x0 = SW / 2 - gap * 2, baseY = SH - 15, maxH = 50;
    const WEIGHT = [6, 4, 3, 1.6, 1];
    const gold = WEIGHT.map((w) => rnd(4, 8) + w * 2.5), shown = gold.slice();
    let coin = null, spawn = 0.3, pause = 0, time = 0;
    const pickHero = () => {
      let r = Math.random() * WEIGHT.reduce((s, w) => s + w, 0), k = 0;
      while (r > WEIGHT[k]) { r -= WEIGHT[k]; k++; }
      return k;
    };
    return {
      step(dt) {
        time += dt;
        for (let i = 0; i < 5; i++) shown[i] += (gold[i] - shown[i]) * Math.min(1, dt * 8);
        if (pause > 0) { pause -= dt; return; }
        if (!coin) { if ((spawn -= dt) <= 0) coin = { t: 0, to: -1, t0: 0 }; return; }
        coin.t += dt;
        if (coin.to < 0 && coin.t > 0.5) { coin.to = pickHero(); coin.t0 = coin.t; }
        if (coin.to >= 0 && coin.t - coin.t0 >= 0.4) {
          gold[coin.to] += 5;
          coin = null; spawn = rnd(0.2, 0.45);
          if (Math.max(...gold) > maxH) { for (let i = 0; i < 5; i++) gold[i] = rnd(4, 8) + WEIGHT[i] * 2.5; pause = 0.7; }
        }
      },
      draw(ctx, c) {
        const reaching = coin && coin.to < 0;
        const coinX = SW / 2, coinY = 11 + Math.sin(time * 6) * 1.5;
        ctx.strokeStyle = c.line; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(14, baseY + 0.5); ctx.lineTo(SW - 14, baseY + 0.5); ctx.stroke();
        ctx.font = `500 8px ${c.mono}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        for (let i = 0; i < 5; i++) {
          const x = x0 + i * gap, h = shown[i];
          box(ctx, x - 5, baseY - h, 10, h, 2);
          ctx.globalAlpha = i === 0 ? 1 : 0.45; ctx.fillStyle = c.accent; ctx.fill();
          let hx = x, hy = baseY - h - 6;
          if (reaching) { hx += (coinX - x) * 0.08; hy -= 2.5 + Math.sin(time * 18 + i) * 1.2; }
          ctx.globalAlpha = 1; ctx.fillStyle = c.ink; dot(ctx, hx, hy, 3.2); ctx.fill();
          ctx.fillStyle = c.muted; ctx.fillText(String(i + 1), x, baseY + 8);
        }
        ctx.textAlign = "start";
        if (coin) {
          let x = coinX, y = coinY;
          if (coin.to >= 0) {
            const p = ease(clamp01((coin.t - coin.t0) / 0.4));
            const tx = x0 + coin.to * gap, ty = baseY - shown[coin.to] - 6;
            x = lerp(coinX, tx, p); y = lerp(coinY, ty, p);
          }
          ctx.globalAlpha = 1; ctx.fillStyle = c.accent2; dot(ctx, x, y, 3.6); ctx.fill();
        }
      },
    };
  },

  // Three teammates on one rotation loop: whoever reaches the ball
  // challenges, the next supports, the last covers the net.
  "rocket-league"() {
    const pts = [[30, 64], [72, 58], [120, 48], [140, 30], [98, 20], [54, 22], [26, 42]];
    const path = [];
    const n = pts.length, SEG = 16;
    for (let k = 0; k < n; k++) {
      const p0 = pts[(k - 1 + n) % n], p1 = pts[k], p2 = pts[(k + 1) % n], p3 = pts[(k + 2) % n];
      for (let s = 0; s < SEG; s++) {
        const t = s / SEG, t2 = t * t, t3 = t2 * t;
        const cr = (i) => 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
        path.push([cr(0), cr(1)]);
      }
    }
    const cum = [0];
    for (let k = 1; k <= path.length; k++) {
      const a = path[k - 1], b = path[k % path.length];
      cum.push(cum[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const L = cum[cum.length - 1];
    const at = (d) => {
      d = ((d % L) + L) % L;
      let k = 0;
      while (cum[k + 1] < d) k++;
      const a = path[k], b = path[(k + 1) % path.length], f = (d - cum[k]) / (cum[k + 1] - cum[k] || 1);
      return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), Math.atan2(b[1] - a[1], b[0] - a[0])];
    };
    const hitD = cum[2 * SEG];
    const home = [pts[2][0] + 8, pts[2][1] - 2];
    const ball = { x: home[0], y: home[1], vx: 0, vy: 0 };
    const speed = L / 6.5;
    let d = 0;
    return {
      step(dt) {
        const prev = d;
        d += speed * dt;
        for (let p = 0; p < 3; p++) {
          const off = (p * L) / 3, a = (prev + off) % L, b = (d + off) % L;
          if (a < hitD && b >= hitD) { ball.vx = rnd(60, 85); ball.vy = rnd(-25, 15); }
        }
        ball.vx += (home[0] - ball.x) * 7 * dt; ball.vy += (home[1] - ball.y) * 7 * dt;
        const damp = Math.pow(0.15, dt);
        ball.vx *= damp; ball.vy *= damp;
        ball.x = Math.min(SW - 12, Math.max(12, ball.x + ball.vx * dt));
        ball.y = Math.min(SH - 12, Math.max(12, ball.y + ball.vy * dt));
      },
      draw(ctx, c) {
        ctx.strokeStyle = c.line; ctx.lineWidth = 1;
        box(ctx, 6.5, 6.5, SW - 13, SH - 13, 12); ctx.stroke();
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(SW / 2, 7); ctx.lineTo(SW / 2, SH - 7); ctx.stroke();
        dot(ctx, SW / 2, SH / 2, 11); ctx.stroke();
        ctx.globalAlpha = 0.9; ctx.beginPath();
        path.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath(); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        ctx.lineWidth = 2;
        ctx.strokeStyle = c.accent2; ctx.beginPath(); ctx.moveTo(4, SH / 2 - 13); ctx.lineTo(4, SH / 2 + 13); ctx.stroke();
        ctx.strokeStyle = c.muted; ctx.beginPath(); ctx.moveTo(SW - 4, SH / 2 - 13); ctx.lineTo(SW - 4, SH / 2 + 13); ctx.stroke();
        // Role by distance still to travel before reaching the ball.
        const cars = [0, 1, 2].map((p) => {
          const pd = d + (p * L) / 3;
          return { pos: at(pd), toBall: (((hitD - pd) % L) + L) % L };
        }).sort((a, b) => a.toBall - b.toBall);
        const roleColor = [c.accent, c.accent2, c.ink];
        cars.forEach((car, r) => {
          const [x, y, ang] = car.pos;
          ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
          ctx.fillStyle = roleColor[r]; box(ctx, -5, -3, 10, 6, 1.6); ctx.fill();
          ctx.restore();
        });
        ctx.fillStyle = c.ink; dot(ctx, ball.x, ball.y, 3.2); ctx.fill();
      },
    };
  },
};

// ===== stage: runs one scene at a time =====
function makeStage(idx) {
  const cv = document.createElement("canvas");
  cv.className = "topics-stage";
  cv.setAttribute("aria-hidden", "true");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = SW * dpr; cv.height = SH * dpr;
  const ctx = cv.getContext("2d");
  let scene = null, raf = 0, last = 0, visible = false, colors = readColors();

  function paint() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SW, SH);
    ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.textAlign = "start";
    scene.draw(ctx, colors);
  }
  function frame(now) {
    raf = 0;
    if (!scene) return;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    scene.step(dt);
    paint();
    schedule();
  }
  function schedule() {
    if (!raf && scene && visible && !REDUCED && !document.hidden) raf = requestAnimationFrame(frame);
  }
  return {
    el: cv,
    play(id) {
      const make = SCENES[id];
      cv.hidden = !make;
      scene = make ? make() : null;
      if (!scene) { console.info("[topics] no animation for", id); return; }
      if (REDUCED) {
        for (let k = 0; k < 120; k++) scene.step(1 / 30);
        paint();
        console.info("[topics] still frame (reduced motion)", { host: idx, id });
        return;
      }
      last = performance.now();
      paint();
      schedule();
      console.info("[topics] animation", { host: idx, id, running: visible });
    },
    setVisible(v) {
      if (v === visible) return;
      visible = v;
      console.info("[topics] stage", v ? "in view, running" : "out of view, paused", { host: idx });
      if (v) { last = performance.now(); schedule(); }
    },
    resume() { last = performance.now(); schedule(); },
    recolor() { colors = readColors(); if (scene) paint(); },
  };
}


function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    if (attrs[k] == null) continue;
    if (k === "text") e.textContent = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  kids.forEach((c) => c != null && e.append(c));
  return e;
}

// Variant E draws the arrow after "Start here" instead of typing it: U+2192 is
// outside the latin subset of the self-hosted fonts and falls back to a system
// font. Variant A keeps the typed arrow (initTopics() without options).
let drawnArrow = false;
const SVG_NS = "http://www.w3.org/2000/svg";
function arrow() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "topics-arrow");
  svg.setAttribute("viewBox", "0 0 14 10");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M1 5H12M8.5 1.5L12 5L8.5 8.5");
  svg.append(path);
  return svg;
}

const stages = [];

function mount(host, idx) {
  const all = [];
  const stage = makeStage(idx);
  stages.push(stage);
  const text = el("div", { class: "topics-text", "aria-live": "polite" });
  const out = el("div", { class: "topics-out" }, stage.el, text);

  function show(topic, groupKey, chip) {
    all.forEach((b) => b.setAttribute("aria-pressed", String(b === chip)));
    out.dataset.group = groupKey;
    const kids = [el("p", { class: "topics-line", text: topic.line })];
    kids.push(drawnArrow
      ? el("a", { class: "topics-cta", href: mailto("Let's talk: " + topic.label) }, T.cta || "Start here", arrow())
      : el("a", { class: "topics-cta", href: mailto("Let's talk: " + topic.label), text: (T.cta || "Start here") + " →" }));
    text.replaceChildren(...kids);
    stage.play(topic.id);
  }

  const groups = (T.groups || []).map((g, gi) => {
    const key = gi === 0 ? "shop" : "off";
    const nameId = "topics-g" + idx + "-" + gi;
    const ul = el("ul", { class: "topics-chips", "aria-labelledby": nameId });
    g.topics.forEach((t) => {
      const b = el("button", { type: "button", class: "topics-chip", "aria-pressed": "false", "data-topic": t.id, text: t.label });
      b.addEventListener("click", () => {
        console.info("[topics] picked", t.id);
        show(t, key, b);
      });
      all.push(b);
      ul.append(el("li", null, b));
    });
    return el("div", { class: "topics-group topics-group--" + key }, el("span", { class: "topics-gname", id: nameId, text: g.name }), ul);
  });

  host.classList.add("topics");
  host.replaceChildren(
    T.sub ? el("p", { class: "topics-sub", text: T.sub }) : null,
    el("div", { class: "topics-groups" }, ...groups),
    out
  );

  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => entries.forEach((e) => stage.setVisible(e.isIntersecting))).observe(out);
  } else {
    stage.setVisible(true);
  }

  // Start with the first topic picked so the panel is never empty.
  const first = T.groups && T.groups[0] && T.groups[0].topics[0];
  if (first && all[0]) show(first, "shop", all[0]);
  console.info("[topics] mounted", { host: idx, topics: all.length, reducedMotion: REDUCED });
}

export function initTopics(opts) {
  drawnArrow = !!(opts && opts.drawnArrow);
  const hosts = document.querySelectorAll("[data-topics]");
  if (!T) { console.info("[topics] no CONTENT.talk, skipping"); return; }
  if (!hosts.length) { console.info("[topics] no [data-topics] host on this page"); return; }
  hosts.forEach(mount);
  document.addEventListener("visibilitychange", () => stages.forEach((s) => s.resume()));
}
