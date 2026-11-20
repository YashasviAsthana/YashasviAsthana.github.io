/* The Nimble stage, part 2: the point field, drawn with Three.js (r170).
   Ported from the A + D blend mockup (stage.js, part 2). Loaded on demand by
   stage-story.js, so Three.js lives in its own chunk.

   Scene 0 is the hero floor itself as points: racks, stations, the painted
   name, and the live robots and orders of the one shared simulation (FloorSim,
   from dispatch.js). Scenes 1 to 4 are the state graph, schedule, assignment
   and event bus, each with its own small simulation and controls. Scene 5
   tilts the same floor into 3D for the full-system simulation; clicking it
   places a real order in the hero's simulation.

   Entity state is written into a small float texture every frame and the
   vertex shader reads it, so tens of thousands of points follow a few dozen
   entities. Every point snaps to a lattice that shares the stage grid's origin
   and renders as a small square tile. */
import * as THREE from "three";

// Set by startGL() from the story module.
let api, FS, COPY, h, $, root, viewEl, REDUCED, COARSE, DEBUG, STATES, TASK;
let dbg = () => {};
// CSS class per task type, for the legend swatches.
const TASK_CLASS = ["travel", "pick", "drop", "charge"];
const cap = (str) => str.charAt(0).toUpperCase() + str.slice(1);
const yieldTask = () => new Promise((r) => setTimeout(r, 0));

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const ease = (t) => t * t * (3 - 2 * t);

const TAU = Math.PI * 2;
const FOV = 35;
const CAM_Z = 11;
const TAN = Math.tan((FOV * Math.PI) / 360);

// Shape ids, one per stage slot.
const S = { FLOOR: 0, STATE: 1, SCHED: 2, ASSIGN: 3, RUST: 4, SIM: 5 };
const NAMES = ["floor", "state graph", "schedule", "assignment", "event bus", "3D floor"];
// Share of points that form the structure; the rest stay behind as faint dust.
const STRUCT = [0.86, 0.62, 0.62, 0.58, 0.62, 0.86];
// Size each D shape is fitted by (world units after its own rotation and scale).
const NOMINAL = [[1, 1], [6.4, 4.0], [7.2, 4.7], [7.1, 3.9], [6.0, 4.9], [1, 1]];
// Resting rotation per shape (pitch, yaw). Also used to order points left to right.
const BASE_EULER = [[Math.PI / 2, 0], [0.1, -0.16], [0.1, -0.3], [0.8, -0.06], [0.2, 0.24], [0.62, -0.32]];
// How hard each scene snaps to the lattice. The story ends by lifting the floor off the
// lattice into real 3D: in perspective, snapped shelving turns to noise.
const SNAP = [1, 1, 1, 1, 1, 0];
// Snapped points stack on shared sites. The floor has one point per site; D's shapes have
// several, so their alpha is scaled down to keep the hue instead of clipping to white.
const SNAP_ALPHA = [1, 0.36, 0.5, 0.42, 0.4, 0.62];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBuilder(M) {
  const pos = new Float32Array(M * 3);
  const meta = new Float32Array(M * 4);
  let n = 0;
  return {
    pos, meta, M,
    full: () => n >= M,
    left: () => M - n,
    count: () => n,
    push(x, y, z, k, hue, a = 0, b = 0) {
      if (n >= M) return false;
      pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z;
      meta[n * 4] = k; meta[n * 4 + 1] = hue; meta[n * 4 + 2] = a; meta[n * 4 + 3] = b;
      n++;
      return true;
    },
  };
}
function gauss(rnd) {
  const u = Math.max(rnd(), 1e-6), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}
function bez(a, c, b, s) {
  const u = 1 - s;
  return [0, 1, 2].map((i) => u * u * a[i] + 2 * u * s * c[i] + s * s * b[i]);
}

/* ========== Layouts shared by D's generators, simulations and labels ========== */

// A generic robot lifecycle (seven states, named in content.ts). Not any real product's states.
const N_STATES = 7;
const SNODE = [[-1.6, 0.0, 0.2], [-0.5, 1.45, -0.2], [1.45, 1.45, 0.25], [2.65, 0.0, -0.15], [1.45, -1.45, 0.2], [-0.5, -1.45, -0.25], [-2.75, -1.3, 0.1]];
const SEDGE = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 6], [6, 0], [1, 0], [5, 1], [5, 6]];
const SBEND = 0.17;
function sCurveJS(e) {
  const A = SNODE[SEDGE[e][0]], Bn = SNODE[SEDGE[e][1]];
  const dx = Bn[0] - A[0], dy = Bn[1] - A[1], dz = Bn[2] - A[2];
  const len = Math.hypot(dx, dy, dz);
  const u = [dx / len, dy / len, dz / len];
  const a = [0, 1, 2].map((i) => A[i] + u[i] * 0.36);
  const b = [0, 1, 2].map((i) => Bn[i] - u[i] * 0.44);
  let px = u[1], py = -u[0];
  const pl = Math.hypot(px, py) || 1; px /= pl; py /= pl;
  const c = [(a[0] + b[0]) / 2 + px * SBEND * len, (a[1] + b[1]) / 2 + py * SBEND * len, (a[2] + b[2]) / 2];
  return { a, c, b, len };
}

const GANTT = { ROWS: 6, NOWX: -1.7, X0: -3.2, X1: 3.2, BAR_H: 0.36, SLOTS: 64, SPEED: 0.3 };
const gRowY = (r) => (2.5 - r) * 0.62;

const AS = { W: 3.0, H: 1.9, SLOTS: 10, MAX: 8, ROBOTS: [[-2.4, -1.1], [-2.0, 1.15], [-0.5, -1.45], [0.45, 1.35], [1.9, -1.05], [2.45, 0.9]] };

const RUST_POS = Array.from({ length: 6 }, (_, k) => {
  const a = Math.PI / 2 - (k * TAU) / 6;
  return [Math.cos(a) * 2.3, Math.sin(a) * 1.65, 0];
});

/* ========== Shape 1: a robot lifecycle as a directed graph ========== */
function genState(M, rnd) {
  const B = makeBuilder(M);
  const perNode = Math.round((M * 0.3) / SNODE.length);
  SNODE.forEach((n, i) => {
    const hue = i / (SNODE.length - 1);
    for (let j = 0; j < perNode; j++) {
      if (j < perNode * 0.62) {
        const u = rnd() * 2 - 1, th = rnd() * TAU, s = Math.sqrt(1 - u * u);
        const r = 0.24 * (1 + gauss(rnd) * 0.03);
        B.push(n[0] + s * Math.cos(th) * r, n[1] + u * r, n[2] + s * Math.sin(th) * r, 70, hue, i);
      } else {
        B.push(n[0] + gauss(rnd) * 0.075, n[1] + gauss(rnd) * 0.075, n[2] + gauss(rnd) * 0.075, 72, hue, i);
      }
    }
  });
  const curves = SEDGE.map((_, e) => sCurveJS(e));
  const perArrow = Math.round((M * 0.07) / SEDGE.length);
  curves.forEach((cv, e) => {
    const p = bez(cv.a, cv.c, cv.b, 0.9);
    for (let j = 0; j < perArrow; j++) B.push(p[0], p[1], p[2], 74, 0, e, 0);
  });
  const nTok = Math.round(M * 0.035);
  for (let j = 0; j < nTok; j++) B.push(SNODE[0][0], SNODE[0][1], SNODE[0][2], 75, 1, 0, 0);
  const lSum = curves.reduce((s, c) => s + c.len, 0);
  const left = B.left();
  curves.forEach((cv, e) => {
    const cnt = e === curves.length - 1 ? B.left() : Math.round((left * cv.len) / lSum);
    for (let j = 0; j < cnt && !B.full(); j++) {
      const s = rnd();
      const p = bez(cv.a, cv.c, cv.b, s);
      B.push(p[0], p[1], p[2], 71, 0, e, s);
    }
  });
  while (!B.full()) B.push(0, 0, 0, 72, 0.5, 0);
  return B;
}

/* ========== Shape 2: a schedule, one row per robot ========== */
function genSched(M, rnd) {
  const B = makeBuilder(M);
  const G = GANTT;
  // Bar points are bound to a bar slot; the shader places them inside that slot's bar.
  const per = Math.floor((M * 0.8) / G.SLOTS);
  for (let s = 0; s < G.SLOTS; s++) {
    const row = s % G.ROWS, x = -3 + Math.floor(s / G.ROWS) * 0.9;
    for (let j = 0; j < per; j++) B.push(x + rnd() * 0.8, gRowY(row) + (rnd() - 0.5) * G.BAR_H, 0, 80, 0, s);
  }
  const top = 1.95, bot = -1.95;
  const nNow = Math.round(M * 0.045);
  for (let j = 0; j < nNow; j++) {
    if (j < nNow * 0.82) B.push(G.NOWX + gauss(rnd) * 0.006, bot + rnd() * (top - bot), 0, 81, 1);
    else { const k = rnd(); B.push(G.NOWX + (rnd() - 0.5) * 0.2 * k, top + 0.02 + k * 0.16, 0, 81, 1); }
  }
  const nRow = Math.round(M * 0.07);
  for (let j = 0; j < nRow; j++) {
    const r = Math.floor(rnd() * G.ROWS);
    B.push(Math.round((G.X0 + rnd() * (G.X1 - G.X0)) / 0.05) * 0.05, gRowY(r) - G.BAR_H / 2 - 0.07, 0, 82, 0);
  }
  while (!B.full()) {
    const k = Math.floor(rnd() * 11) - 2;
    const x = G.NOWX + k * 0.6;
    B.push(x + gauss(rnd) * 0.004, bot - 0.02 - rnd() * (k % 2 === 0 ? 0.14 : 0.07), 0, 83, 0.2);
  }
  return B;
}

/* ========== Shape 3: robots and orders on a floor, joined by assignment streams ========== */
function genAssign(M, rnd) {
  const B = makeBuilder(M);
  const { W, H } = AS;
  const q7 = (v) => Math.round(v / 0.07) * 0.07;
  const nFloor = Math.round(M * 0.2);
  for (let j = 0; j < nFloor; j++) {
    const w = rnd();
    let x, z;
    if (w < 0.25) {
      let q = rnd() * (4 * W + 4 * H);
      if (q < 2 * W) { x = -W + q; z = -H; }
      else if ((q -= 2 * W) < 2 * H) { x = W; z = -H + q; }
      else if ((q -= 2 * H) < 2 * W) { x = W - q; z = H; }
      else { x = -W; z = H - (q - 2 * W); }
      x = q7(x); z = q7(z);
    } else if (w < 0.62) { x = Math.round(((rnd() * 2 - 1) * W) / 0.6) * 0.6; z = q7((rnd() * 2 - 1) * H); }
    else { z = Math.round(((rnd() * 2 - 1) * H) / 0.6) * 0.6; x = q7((rnd() * 2 - 1) * W); }
    B.push(x, 0, z, 93, 0.3);
  }
  const perRobot = Math.round((M * 0.15) / AS.ROBOTS.length);
  AS.ROBOTS.forEach(([x, z], i) => {
    for (let j = 0; j < perRobot; j++) {
      const q = j / perRobot;
      if (q < 0.58) { const a = rnd() * TAU, r = 0.17 + gauss(rnd) * 0.004; B.push(x + Math.cos(a) * r, 0.01, z + Math.sin(a) * r, 92, 1, i); }
      else if (q < 0.82) B.push(x + gauss(rnd) * 0.008, 0.02 + rnd() * 0.38, z + gauss(rnd) * 0.008, 92, 1, i);
      else B.push(x + gauss(rnd) * 0.04, 0.44 + gauss(rnd) * 0.04, z + gauss(rnd) * 0.04, 92, 1, i);
    }
  });
  const perOrder = Math.round((M * 0.12) / AS.SLOTS);
  for (let q = 0; q < AS.SLOTS; q++) {
    const x = (rnd() * 2 - 1) * W, z = (rnd() * 2 - 1) * H;
    for (let j = 0; j < perOrder; j++) B.push(x, 0.08, z, 90, 0, q);
  }
  const left = B.left(), R = AS.ROBOTS.length;
  for (let j = 0; j < left; j++) {
    const k = j % R, s = rnd();
    const [x, z] = AS.ROBOTS[k];
    B.push(x * (1 - s * 0.5), 0.3, z * (1 - s * 0.5), 91, 0.5, k, s);
  }
  return B;
}

/* ========== Shape 4: subsystems around an event bus ========== */
function genRust(M, rnd) {
  const B = makeBuilder(M);
  const L = [-0.27, -0.09, 0.09, 0.27];
  const pickL = () => L[Math.floor(rnd() * 4)];
  const perNode = Math.round((M * 0.58) / RUST_POS.length);
  RUST_POS.forEach((c, k) => {
    for (let j = 0; j < perNode; j++) {
      let l;
      if (j < perNode * 0.7) {
        const ax = Math.floor(rnd() * 3), a = pickL(), b = pickL(), s = (rnd() - 0.5) * 0.54;
        l = ax === 0 ? [s, a, b] : ax === 1 ? [a, s, b] : [a, b, s];
      } else l = [pickL() + gauss(rnd) * 0.008, pickL() + gauss(rnd) * 0.008, pickL() + gauss(rnd) * 0.008];
      // Turn the cube so its depth shows: yaw then pitch.
      const ya = 0.62, pa = 0.42;
      const x1 = l[0] * Math.cos(ya) + l[2] * Math.sin(ya), z1 = -l[0] * Math.sin(ya) + l[2] * Math.cos(ya);
      const y2 = l[1] * Math.cos(pa) - z1 * Math.sin(pa), z2 = l[1] * Math.sin(pa) + z1 * Math.cos(pa);
      B.push(c[0] + x1, c[1] + y2, c[2] + z2, 100, k / 5, k);
    }
  });
  const nRing = Math.round(M * 0.07);
  for (let j = 0; j < nRing; j++) {
    const a = rnd() * TAU, inner = j > nRing * 0.75, r = (inner ? 0.66 : 0.85) + gauss(rnd) * 0.012;
    B.push(Math.cos(a) * r, Math.sin(a) * r, gauss(rnd) * 0.012, 103, 0.5, 0, inner ? 1 : 0);
  }
  const nSpoke = Math.round(M * 0.05);
  for (let j = 0; j < nSpoke; j++) {
    const c = RUST_POS[j % 6], l = Math.hypot(c[0], c[1]);
    const s = Math.round(rnd() / 0.05) * 0.05;
    const f = 0.92 / l + s * (1 - 0.5 / l - 0.92 / l);
    B.push(c[0] * f, c[1] * f, 0, 104, 0.3);
  }
  const nEv = Math.round(M * 0.17);
  for (let j = 0; j < nEv; j++) {
    const c = RUST_POS[j % 6], s = rnd();
    B.push(c[0] * (0.4 + s * 0.5), c[1] * (0.4 + s * 0.5), 0, j % 2 ? 105 : 101, 0.5, j % 6, rnd());
  }
  while (!B.full()) { const a = rnd() * TAU; B.push(Math.cos(a) * 0.85, Math.sin(a) * 0.85, 0, 102, 0.5, 0, rnd()); }
  return B;
}

/* ========== Shapes 0 and 5: the hero floor, from the shared simulation ========== */

// Floor-local coordinates are floor cells: x is the column, z is the row, y is height.
// Points are listed by priority so a tight budget drops dust-like fill before structure.
function floorParts(G, mask, nRobots, flat) {
  const { F } = G;
  // The flat scene may be scaled down with its own lattice; the 3D scene keeps the 1:1 one.
  const sub = flat ? G.sub : G.subSim;
  const T = F.type, cols = F.cols, rows = F.rows, K = F.kinds;
  const at = (c, r) => (c < 0 || r < 0 || c >= cols || r >= rows ? -1 : T[r * cols + c]);
  const tiers = [[], [], [], []];
  const push = (tier, x, y, z, k, hue, a = 0, b = 0) => tiers[tier].push([x, y, z, k, hue, a, b]);
  const site = (i) => (i + 0.5) / sub;
  const { c0, c1, r0, r1 } = flat ? G.flat : G.sim;

  // Robots: a square ring body, a tote in the middle and a status light, in robot-local cells.
  // The nearest odd number of sites to A's 0.62-cell robot, so a parked robot sits on its cell's centre site.
  const n = Math.max(3, 2 * Math.round((0.62 * sub - 1) / 2) + 1);
  const off = (i) => (i - (n - 1) / 2) / sub;
  for (let j = 0; j < nRobots; j++) {
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
      const ring = i === 0 || k === 0 || i === n - 1 || k === n - 1;
      const x = off(i), z = off(k);
      if (ring) {
        push(0, x, flat ? 0 : 0.32, z, 140, 0, j, 0);
        if (!flat && (i + k) % 2 === 0) push(0, x, 0.12, z, 140, 0, j, 0);
      } else {
        push(0, x, flat ? 0 : 0.42, z, 140, 0, j, 3);
        if (!flat) push(0, x, 0.6, z, 140, 0, j, 3);
        if (Math.abs(x) < 0.5 / sub && Math.abs(z) < 0.5 / sub) push(0, x * 0.5, flat ? 0 : 0.36, z * 0.5, 140, 0, j, 2);
      }
    }
    if (n <= 3) push(0, 0, flat ? 0 : 0.36, 0, 140, 0, j, 2);
  }
  // Orders: a filled tile, a frame once a robot claims it, and a ring when it is born. Unit offsets.
  const ORD = 48;
  for (let q = 0; q < ORD; q++) {
    const y = flat ? 0 : 0.5;
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) push(0, (i - 1) / 2.4, y, (k - 1) / 2.4, 141, 0, q, 0);
    for (let e = 0; e < 12; e++) {
      const s = e / 12, side = Math.floor(s * 4), f = (s * 4) % 1 - 0.5;
      const [x, z] = side === 0 ? [f, -0.5] : side === 1 ? [0.5, f] : side === 2 ? [-f, 0.5] : [-0.5, -f];
      push(0, x, y, z, 141, 0, q, 1);
      push(0, x, y, z, 141, 0, q, 2);
    }
  }

  // Racks: flat tiles on the floor, or extruded shelving in 3D.
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    if (at(c, r) !== K.RACK) continue;
    const L = at(c - 1, r) === K.RACK, R = at(c + 1, r) === K.RACK, U = at(c, r - 1) === K.RACK, D = at(c, r + 1) === K.RACK;
    if (flat) {
      for (let i = 0; i < sub; i++) for (let k = 0; k < sub; k++) {
        if ((!L && i === 0) || (!R && i === sub - 1) || (!U && k === 0) || (!D && k === sub - 1)) continue;
        const rim = (!L && i === 1) || (!R && i === sub - 2) || (!U && k === 1) || (!D && k === sub - 2);
        const seam = L && i === 0;
        if (rim) push(1, c + site(i), 0, r + site(k), 120, 0.5);
        else if (seam) push(2, c + site(i), 0, r + site(k), 121, 0.5, 1);
        else if ((i + k) % 2 === 0) push(3, c + site(i), 0, r + site(k), 121, 0.5);
      }
    } else {
      const H = 1.6, lv = [0, H * 0.5, H];
      const steps = 3;
      // Posts at the cell corners on the block's outline.
      const corners = [[0, 0, !L || !U], [1, 0, !R || !U], [0, 1, !L || !D], [1, 1, !R || !D]];
      for (const [cx, cz, on] of corners) {
        if (!on) continue;
        for (let s = 0; s <= 8; s++) push(1, c + 0.06 + cx * 0.88, (H * s) / 8, r + 0.06 + cz * 0.88, 130, 0.5);
      }
      // Shelf edges on outer faces, at each level.
      for (const y of lv) {
        for (let s = 1; s < steps; s++) {
          const f = 0.06 + (0.88 * s) / steps;
          if (!U) push(y === H ? 1 : 2, c + f, y, r + 0.06, 130, 0.5);
          if (!D) push(y === H ? 1 : 2, c + f, y, r + 0.94, 130, 0.5);
          if (!L) push(y === H ? 1 : 2, c + 0.06, y, r + f, 130, 0.5);
          if (!R) push(y === H ? 1 : 2, c + 0.94, y, r + f, 130, 0.5);
        }
        if (y === H) push(2, c + 0.5, y, r + 0.5, 130, 0.5);
      }
      // A few totes on the shelves.
      const hsh = ((c * 73856093) ^ (r * 19349663)) >>> 0;
      if (hsh % 3 !== 0) {
        const y = lv[hsh % 2] + 0.06, hue = hsh % 5 < 2 ? 1 : 0;
        for (let i = 0; i < 4; i++) push(3, c + 0.32 + (i % 2) * 0.36, y + 0.1 * Math.floor(i / 2), r + 0.5, 131, hue, (hsh % 97) / 97);
      }
    }
  }

  // Stations: an accent-2 frame and a light fill, like the hero.
  for (const st of F.stations) {
    if (st.c0 + st.w < c0 || st.c0 > c1 + 1 || st.r0 + st.h < r0 || st.r0 > r1 + 1) continue;
    const x0 = st.c0 + 0.1, x1 = st.c0 + st.w - 0.04, z0 = st.r0 + 0.1, z1 = st.r0 + st.h - 0.1;
    const nx = Math.max(2, Math.round((x1 - x0) * sub)), nz = Math.max(2, Math.round((z1 - z0) * sub));
    for (let i = 0; i <= nx; i++) for (let k = 0; k <= nz; k++) {
      const x = x0 + ((x1 - x0) * i) / nx, z = z0 + ((z1 - z0) * k) / nz;
      const edge = i === 0 || k === 0 || i === nx || k === nz;
      if (edge) {
        push(1, x, 0, z, 122, 1, st.i);
        if (!flat) { push(1, x, 0.55, z, 122, 1, st.i); }
      } else if ((i + k) % 2 === 0) push(2, x, 0, z, 123, 1, st.i);
    }
    if (!flat) for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) for (let s = 1; s < 5; s++) push(1, x, (0.55 * s) / 5, z, 122, 1, st.i);
  }

  // The painted name, sampled from the hero's own stencil.
  if (mask) {
    const { alpha, w, h, rect } = mask;
    const step = flat ? 1 : 2;
    const bc0 = Math.max(c0, Math.floor((rect.x - F.ox) / F.cell)), bc1 = Math.min(c1, Math.ceil((rect.x + rect.w - F.ox) / F.cell));
    const br0 = Math.max(r0, Math.floor((rect.y - F.oy) / F.cell)), br1 = Math.min(r1, Math.ceil((rect.y + rect.h - F.oy) / F.cell));
    for (let r = br0; r <= br1; r++) for (let c = bc0; c <= bc1; c++) {
      for (let i = 0; i < sub; i += step) for (let k = 0; k < sub; k += step) {
        const x = c + site(i), z = r + site(k);
        const hx = F.ox + x * F.cell - rect.x, hy = F.oy + z * F.cell - rect.y;
        if (hx < 0 || hy < 0 || hx >= rect.w || hy >= rect.h) continue;
        const a = alpha[(Math.floor((hy / rect.h) * h) * w + Math.floor((hx / rect.w) * w)) * 4 + 3];
        if (a > 70) push(flat ? 2 : 3, x, 0, z, 124, 0, a / 255);
      }
    }
  }

  // Keep-out zones: hatched edges for the hero panel, a hairline for the telemetry booth.
  for (const z of F.zones) {
    const zc0 = z.c0, zc1 = z.c1 + 1, zr0 = z.r0, zr1 = z.r1 + 1;
    const nx = Math.round((zc1 - zc0) * sub), nz = Math.round((zr1 - zr0) * sub);
    const sideOn = { L: zc0 > 0, R: zc1 < cols, T: zr0 > 0, B: zr1 < rows };
    for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
      const x = zc0 + (i + 0.5) / sub, zz = zr0 + (k + 0.5) / sub;
      if (x < c0 || x > c1 + 1 || zz < r0 || zz > r1 + 1) continue;
      const band = z.kind === "panel" ? 2 : 1;
      const near = (sideOn.L && i < band) || (sideOn.R && i >= nx - band) || (sideOn.T && k < band) || (sideOn.B && k >= nz - band);
      if (!near) continue;
      if (z.kind === "panel") { if ((i + k) % 3 !== 0) push(2, x, 0, zz, 125, 0); }
      else push(3, x, 0, zz, 126, 0.5);
    }
  }

  // 3D only: floor joints, so the tilted floor still reads as A's grid.
  if (!flat) {
    for (let r = r0; r <= r1 + 1; r++) for (let c = c0; c <= c1 + 1; c++) {
      push(3, c, 0, r, 132, 0.5);
      if (c <= c1) push(3, c + 0.5, 0, r, 132, 0.5, 1);
      if (r <= r1) push(3, c, 0, r + 0.5, 132, 0.5, 1);
    }
  }
  return tiers;
}

function genFloor(budget, rnd, G, mask, nRobots, flat) {
  const tiers = floorParts(G, mask, nRobots, flat);
  // Fill by priority; thin the lowest tier that does not fit.
  const out = [];
  let left = budget;
  for (const tier of tiers) {
    if (tier.length <= left) { out.push(...tier); left -= tier.length; continue; }
    const keep = left / tier.length;
    for (const p of tier) if (rnd() < keep && left > 0) { out.push(p); left--; }
    break;
  }
  const B = makeBuilder(Math.max(1, out.length));
  for (const p of out) B.push(...p);
  return B;
}

/* ========== Shaders ========== */

// Data texture rows (64 entities wide): written by the simulations every frame.
const ROW = {
  SNODE: 0, SNODE2: 1, SEDGE: 2, BAR: 3, BAR2: 4, AROB: 5, AROB2: 6, AORD: 7, AORD2: 8, RNODE: 9, RNODE2: 10,
  FROB: 11, FROB2: 12, FORD: 13, GLOB: 14, FORD2: 15, FST: 16,
};
const DW = 64, DH = 17;

const VERT = /* glsl */ `
attribute vec4 aFromMeta;
attribute vec3 aTo;
attribute vec4 aToMeta;
attribute vec4 aRand;

uniform float uTime, uProgress;
uniform int uFrom, uTo;
uniform mat4 uXFrom, uXTo;
uniform float uFitFrom, uFitTo;
uniform float uPx, uSize, uLight, uSwirl, uFocus, uDof, uAlpha, uSnapAlphaFrom, uSnapAlphaTo;
uniform float uSnapFrom, uSnapTo, uPitchFrom, uPitchTo;
uniform vec2 uRes, uGridOffFrom, uGridOffTo;
uniform vec4 uRegion;
uniform vec3 uAccent, uAccent2, uInk, uMuted;
uniform highp sampler2D uData;

varying vec3 vColor;
varying float vAlpha;
varying float vSoft;
varying float vSquare;

const float TAU = 6.28318530718;

struct Pt { vec3 p; float glow; float hue; float alpha; float size; float soft; float mute; float ink; };

Pt pt(vec3 p) { Pt o; o.p = p; o.glow = 0.0; o.hue = 0.5; o.alpha = 0.5; o.size = 1.0; o.soft = 0.0; o.mute = 0.0; o.ink = 0.0; return o; }
vec4 D(int i, int row) { return texelFetch(uData, ivec2(i, row), 0); }
int I(float v) { return int(v + 0.5); }
vec3 bez(vec3 a, vec3 c, vec3 b, float s) { float u = 1.0 - s; return u * u * a + 2.0 * u * s * c + s * s * b; }
vec3 bezT(vec3 a, vec3 c, vec3 b, float s) { return normalize(2.0 * (1.0 - s) * (c - a) + 2.0 * s * (b - c) + vec3(1e-5)); }
vec3 tube(vec3 tg, vec4 r, float rad) {
  vec3 n1 = normalize(cross(tg, vec3(0.0, 0.0, 1.0)) + vec3(1e-4, 2e-4, 0.0));
  vec3 n2 = cross(tg, n1);
  float a = r.y * TAU;
  return (n1 * cos(a) + n2 * sin(a)) * rad * sqrt(r.z);
}
vec3 swirl(vec3 p, float t) {
  return vec3(
    sin(p.y * 1.3 + t * 0.7) + sin(p.z * 0.9 - t * 0.4),
    sin(p.z * 1.1 + t * 0.6) + sin(p.x * 0.8 + t * 0.5),
    sin(p.x * 1.2 - t * 0.5) + sin(p.y * 0.7 + t * 0.3)) * 0.5;
}

// Spare points: hidden on the floor scenes, a sparse faint drift behind D's shapes.
Pt dust(vec3 b, vec4 m, vec4 r, float t, int id) {
  vec3 p = b + vec3(sin(t * 0.11 + r.y * TAU), cos(t * 0.09 + r.z * TAU), sin(t * 0.07 + r.w * TAU)) * 0.25;
  Pt o = pt(p);
  o.hue = m.y; o.size = 0.8; o.mute = 0.4;
  o.alpha = (id == 0 || id == 5) ? 0.0 : 0.2 * step(0.9, r.w);
  return o;
}

// State graph: node rows hold (pos, emphasis) and (flash, current); edge rows (from, to, bend, emphasis).
vec3 sNode(int n) { return D(n, 0).xyz; }
void sCurve(int e, out vec3 a, out vec3 c, out vec3 b) {
  vec4 E = D(e, 2);
  vec3 A = sNode(I(E.x)), B = sNode(I(E.y));
  float len = length(B - A);
  vec3 dir = (B - A) / len;
  a = A + dir * 0.36;
  b = B - dir * 0.44;
  vec3 perp = normalize(vec3(dir.y, -dir.x, 0.0) + vec3(1e-5));
  c = (a + b) * 0.5 + perp * E.z * len;
}
Pt stateShape(vec3 b, vec4 m, vec4 r, float t) {
  int k = I(m.x);
  if (k == 71 || k == 74) {
    int e = I(m.z);
    float em = D(e, 2).w;
    vec3 a, c, d;
    sCurve(e, a, c, d);
    float lit = smoothstep(0.5, 0.9, em);
    if (k == 74) {
      float u = r.y, v = (r.z * 2.0 - 1.0) * (1.0 - u);
      float s = mix(0.8, 0.995, u);
      vec3 tg = bezT(a, c, d, s);
      vec3 n1 = normalize(cross(tg, vec3(0.0, 0.0, 1.0)) + vec3(1e-4));
      Pt o = pt(bez(a, c, d, s) + n1 * v * 0.1);
      o.alpha = mix(0.12, 1.0, em); o.glow = em * em * 0.7; o.hue = lit; o.size = 0.85;
      return o;
    }
    float s = fract(m.w + t * mix(0.05, 0.18, em));
    Pt o = pt(bez(a, c, d, s) + tube(bezT(a, c, d, s), r, 0.028));
    o.alpha = mix(0.05, 0.75, em) * (0.4 + 0.6 * s);
    o.glow = em * em * 0.6 * s;
    o.hue = lit;
    o.size = 0.78;
    return o;
  }
  if (k == 75) {
    vec4 tk = D(0, 14);
    vec3 pos;
    if (tk.x < 0.5) { vec3 a, c, d; sCurve(I(tk.y), a, c, d); pos = bez(a, c, d, tk.z); }
    else pos = sNode(I(tk.w)) + vec3(0.0, 0.0, 0.3);
    vec3 dir = normalize(r.yzw - 0.5 + vec3(1e-4));
    Pt o = pt(pos + dir * 0.12 * sqrt(fract(r.y * 7.31 + r.z * 3.17)));
    o.glow = 0.95; o.alpha = 0.95; o.hue = 1.0; o.size = 1.0;
    return o;
  }
  int n = I(m.z);
  vec4 N = D(n, 0);
  vec4 N2 = D(n, 1);
  vec3 l = b - N.xyz;
  float core = step(71.5, m.x);
  float br = 1.0 + 0.04 * sin(t * 1.4 + m.z * 1.7) + N2.x * 0.25 + N2.y * 0.1;
  Pt o = pt(N.xyz + l * br + vec3(sin(t * 38.0) * 0.035 * N2.x, 0.0, 0.0));
  o.alpha = mix(0.16, 0.85, N.w) * mix(0.75, 1.0, core) + N2.x * 0.4;
  o.glow = mix(0.0, 0.35, N.w) * mix(0.6, 1.0, core) + N2.x * 0.9 + N2.y * 0.2;
  o.hue = mix(m.y, 1.0, N2.y * 0.6);
  o.size = mix(0.85, 1.0, core);
  return o;
}

// Schedule: bar rows hold (row, x, length, type) and (alpha, glow, hover).
const float G_NOWX = ${GANTT.NOWX.toFixed(2)};
const float G_BARH = ${GANTT.BAR_H.toFixed(2)};
Pt schedShape(vec3 b, vec4 m, vec4 r, float t) {
  int k = I(m.x);
  if (k == 80) {
    int sl = I(m.z);
    vec4 A = D(sl, 3);
    vec4 Bf = D(sl, 4);
    float type = A.w, len = max(A.z, 0.01);
    float u = r.y, v = r.z;
    if (type < 0.5) {
      // Travel is drawn as an outline only, so it reads as movement rather than work.
      float per = 2.0 * (len + G_BARH);
      float q = r.y * per;
      if (q < len) { u = q / len; v = 0.0; }
      else if (q < len + G_BARH) { u = 1.0; v = (q - len) / G_BARH; }
      else if (q < 2.0 * len + G_BARH) { u = 1.0 - (q - len - G_BARH) / len; v = 1.0; }
      else { u = 0.0; v = 1.0 - (q - 2.0 * len - G_BARH) / G_BARH; }
    }
    float x = A.y + u * len;
    Pt o = pt(vec3(x, (2.5 - A.x) * 0.62 + (v - 0.5) * G_BARH, (r.w - 0.5) * 0.04));
    float vis = (1.0 - smoothstep(2.95, 3.35, x)) * smoothstep(-3.5, -3.05, x);
    float past = step(x, G_NOWX);
    float run = step(A.y, G_NOWX) * step(G_NOWX, A.y + len);
    o.alpha = Bf.x * vis * (type < 0.5 ? 0.6 : 0.62) * mix(1.0, 0.4, past * (1.0 - run)) * (1.0 + Bf.z * 0.5);
    o.glow = run * 0.3 + Bf.y * 0.7 + Bf.z * 0.45;
    o.ink = type > 2.5 ? 0.85 : 0.0;
    o.hue = type < 0.5 ? 0.5 : (type < 1.5 ? 0.0 : (type < 2.5 ? 1.0 : 0.5));
    o.mute = type < 0.5 ? 0.55 : 0.0;
    o.size = 0.85;
    return o;
  }
  Pt o = pt(b);
  if (k == 81) { o.alpha = 0.9; o.glow = 0.55; o.hue = 1.0; o.size = 0.9; }
  else if (k == 82) { o.alpha = 0.16; o.mute = 1.0; o.size = 0.7; }
  else { o.alpha = 0.32; o.mute = 0.8; o.size = 0.75; }
  return o;
}

// Assignment: robot rows hold (x, z, swap, active) and (prevX, prevZ, nextX, nextZ);
// order rows hold (x, z, alpha, assigned) and (hover).
Pt assignShape(vec3 b, vec4 m, vec4 r, float t) {
  int k = I(m.x);
  if (k == 91) {
    int j = I(m.z);
    vec4 R = D(j, 5);
    vec4 P = D(j, 6);
    float s = fract(m.w + t * 0.24);
    float sw = clamp(R.z * 1.4 - s * 0.4, 0.0, 1.0);
    sw = sw * sw * (3.0 - 2.0 * sw);
    vec3 A = vec3(R.x, 0.44, R.y);
    vec3 Bt = vec3(mix(P.x, P.z, sw), 0.1, mix(P.y, P.w, sw));
    float len = length(Bt - A);
    vec3 c = (A + Bt) * 0.5 + vec3(0.0, 0.3 + 0.2 * len, 0.0);
    Pt o = pt(bez(A, c, Bt, s) + tube(bezT(A, c, Bt, s), r, 0.022));
    float ends = smoothstep(0.0, 0.06, s) * (1.0 - smoothstep(0.92, 1.0, s));
    float packet = step(0.85, fract(m.w * 9.0));
    o.alpha = R.w * ends * (0.16 + 0.4 * packet) * smoothstep(0.05, 0.3, len);
    o.glow = 0.05 + packet * 0.55;
    o.hue = 1.0 - s * 0.7;
    o.size = 0.78 + packet * 0.25;
    return o;
  }
  if (k == 90) {
    int q = I(m.z);
    vec4 O = D(q, 7);
    float hl = D(q, 8).x;
    vec3 off = vec3(r.y - 0.5, r.z, r.w - 0.5) * 0.17;
    Pt o = pt(vec3(O.x, 0.0, O.y) + off * (1.0 + hl * 0.35));
    float wait = 1.0 - O.w;
    float pulse = 0.5 + 0.5 * sin(t * 3.0 + m.z);
    o.alpha = O.z * (0.5 + 0.35 * O.w + 0.25 * hl) * mix(1.0, 0.55 + 0.45 * pulse, wait);
    o.glow = 0.08 + 0.35 * O.w + 0.6 * hl;
    o.hue = 0.0;
    o.size = 0.85;
    return o;
  }
  Pt o = pt(b);
  if (k == 92) {
    float act = D(I(m.z), 5).w;
    o.alpha = 0.32 + 0.3 * act; o.ink = 0.55 + 0.3 * act; o.glow = 0.04 + 0.3 * act; o.hue = 1.0; o.size = 0.85;
  } else { o.alpha = 0.16; o.mute = 1.0; o.size = 0.7; }
  return o;
}

// Event bus: node rows hold (pos, migrated) and (hover); globals hold the ring speed.
Pt rustShape(vec3 b, vec4 m, vec4 r, float t) {
  int k = I(m.x);
  vec4 G = D(2, 14);
  if (k == 100) {
    int n = I(m.z);
    vec4 N = D(n, 9);
    float hl = D(n, 10).x;
    float ls = clamp(N.w * 1.6 - r.y * 0.6, 0.0, 1.0);
    ls = ls * ls * (3.0 - 2.0 * ls);
    vec3 dir = normalize(r.yzw - 0.5 + vec3(1e-4));
    float rad = 0.5 * sqrt(fract(r.y * 13.7 + r.z * 7.1));
    vec3 jit = vec3(sin(t * 2.3 + r.y * 40.0), sin(t * 2.9 + r.z * 40.0), sin(t * 2.1 + r.w * 40.0)) * 0.06;
    Pt o = pt(mix(N.xyz + dir * rad + jit, b, ls));
    o.alpha = mix(0.34, 0.68, ls) + hl * 0.25;
    o.glow = mix(0.0, 0.2, ls) + hl * 0.4 + ls * (1.0 - ls) * 2.0;
    o.hue = ls;
    o.size = mix(1.0, 0.82, ls);
    o.soft = (1.0 - ls) * 0.5;
    return o;
  }
  if (k == 101 || k == 105) {
    vec4 N = D(I(m.z), 9);
    float mig = N.w;
    vec3 dir = normalize(N.xyz + vec3(1e-4));
    vec3 outer = N.xyz - dir * 0.5, inner = dir * 0.92;
    float s = fract(m.w + t * mix(0.16, 0.7, mig));
    s = clamp(s + (1.0 - mig) * 0.05 * sin(t * 4.0 + m.w * 37.0), 0.0, 1.0);
    vec3 side = normalize(cross(dir, vec3(0.0, 0.0, 1.0))) * (k == 101 ? 0.07 : -0.07);
    vec3 p = k == 101 ? mix(outer, inner, s) : mix(inner, outer, s);
    Pt o = pt(p + side + (r.yzw - 0.5) * 0.02);
    // Python events arrive in uneven clumps; Rust ones in a steady stream.
    float burst = mix(step(0.55, fract(m.w * 3.0 + t * 0.4)), 1.0, mig);
    o.alpha = (0.4 + 0.4 * mig) * burst * smoothstep(0.0, 0.08, s) * (1.0 - smoothstep(0.92, 1.0, s));
    o.glow = 0.25 + 0.5 * mig;
    o.hue = mig;
    o.size = 0.85;
    return o;
  }
  if (k == 102) {
    float a = m.w * TAU + t * G.x;
    Pt o = pt(vec3(cos(a), sin(a), 0.0) * 0.85 + (r.yzw - 0.5) * 0.03);
    o.alpha = 0.42; o.glow = 0.4; o.hue = 0.5 + 0.5 * G.y; o.size = 0.85;
    return o;
  }
  Pt o = pt(b);
  if (k == 103) { o.alpha = 0.3 * (m.w > 0.5 ? 0.45 : 1.0); o.glow = 0.08; o.hue = 0.6; o.size = 0.78; }
  else { o.alpha = 0.16; o.mute = 1.0; o.size = 0.7; }
  return o;
}

// The hero floor. Robot rows hold (x, z, angle, present) and (tote, light, idle);
// order rows hold (x, z, size, alpha) and (claimed, user, birth); station rows hold (flash).
// The 3D floor shows only the stage's window onto the floor; entities fade out at its edge.
float inRegion(float x, float z, float isFlat) {
  if (isFlat > 0.5) return 1.0;
  return smoothstep(uRegion.x - 0.2, uRegion.x + 0.4, x) * (1.0 - smoothstep(uRegion.y - 0.4, uRegion.y + 0.2, x))
       * smoothstep(uRegion.z - 0.2, uRegion.z + 0.4, z) * (1.0 - smoothstep(uRegion.w - 0.4, uRegion.w + 0.2, z));
}
Pt floorShape(vec3 b, vec4 m, vec4 r, float t, float isFlat) {
  int k = I(m.x);
  if (k == 140) {
    int j = I(m.z);
    vec4 R = D(j, ${ROW.FROB});
    vec4 R2 = D(j, ${ROW.FROB2});
    float ca = cos(R.z), sa = sin(R.z);
    vec3 l = vec3(b.x * ca - b.z * sa, b.y, b.x * sa + b.z * ca);
    Pt o = pt(vec3(R.x, 0.0, R.y) + l);
    int part = I(m.w);
    if (part == 0) { o.ink = 1.0; o.alpha = mix(1.45, 0.85, R2.z); o.size = 1.0; }
    else if (part == 2) { o.hue = 1.0; o.alpha = R2.y * 1.5; o.glow = 0.1; o.size = 1.0; }
    else { o.hue = 0.0; o.alpha = R2.x * 1.45; o.glow = 0.1; o.size = 0.95; }
    o.alpha *= R.w * inRegion(R.x, R.y, isFlat);
    return o;
  }
  if (k == 141) {
    int q = I(m.z);
    vec4 O = D(q, ${ROW.FORD});
    vec4 O2 = D(q, ${ROW.FORD2});
    int part = I(m.w);
    float sc = O.z * (part == 0 ? 1.0 : part == 1 ? 1.6 : (0.8 + O2.z * 2.6));
    Pt o = pt(vec3(O.x + b.x * sc, b.y, O.y + b.z * sc));
    float reg = inRegion(O.x, O.y, isFlat);
    if (part == 0) { o.hue = 0.0; o.alpha = O.w * 1.5 * reg; o.glow = 0.06; }
    else if (part == 1) { o.hue = 1.0; o.alpha = O2.x * 1.3 * step(0.01, O.w) * reg; o.size = 0.85; }
    else { o.hue = 0.0; o.alpha = O2.z > 0.0 ? 1.1 * (1.0 - O2.z) * step(0.01, O.w) * reg : 0.0; o.size = 0.85; }
    return o;
  }
  Pt o = pt(b);
  o.size = 0.9;
  if (k == 120) { o.mute = 1.0; o.alpha = mix(0.8, 0.95, isFlat); o.size = 0.95; }
  else if (k == 121) { o.mute = 1.0; o.alpha = m.z > 0.5 ? 0.22 : 0.4; o.size = 0.85; }
  else if (k == 122 || k == 123) {
    float fl = D(I(m.z), ${ROW.FST}).x;
    o.hue = 1.0;
    o.alpha = (k == 122 ? 1.2 : 0.3) + fl * 0.7;
    o.glow = fl * 0.5;
  }
  else if (k == 124) { o.hue = 0.0; o.alpha = m.z * mix(0.6, 0.62, isFlat); o.size = 0.9; }
  else if (k == 125) { o.hue = 0.0; o.alpha = 0.8; o.size = 0.85; }
  else if (k == 126) { o.mute = 1.0; o.alpha = 0.45; o.size = 0.7; }
  else if (k == 130) { o.mute = 1.0; o.alpha = 0.7; o.size = 0.85; o.glow = 0.05; }
  else if (k == 131) {
    float blink = smoothstep(0.96, 1.0, sin(t * 0.5 + m.z * TAU));
    o.hue = m.y; o.alpha = 0.34 + blink * 0.5; o.glow = 0.04 + blink * 0.7; o.size = 0.85;
  }
  else { o.mute = 1.0; o.alpha = m.z > 0.5 ? 0.18 : 0.36; o.size = 0.7; }
  return o;
}

Pt evalShape(int id, vec3 b, vec4 m, vec4 r, float t) {
  if (m.x < 0.5) return dust(b, m, r, t, id);
  if (id == 0) return floorShape(b, m, r, t, 1.0);
  if (id == 1) return stateShape(b, m, r, t);
  if (id == 2) return schedShape(b, m, r, t);
  if (id == 3) return assignShape(b, m, r, t);
  if (id == 4) return rustShape(b, m, r, t);
  return floorShape(b, m, r, t, 0.0);
}

void main() {
  float t = uTime;
  Pt A = evalShape(uFrom, position, aFromMeta, aRand, t);
  bool dustA = aFromMeta.x < 0.5;
  vec3 p = dustA ? A.p : (uXFrom * vec4(A.p, 1.0)).xyz;
  float fit = dustA ? 1.0 : uFitFrom;
  float snap = uSnapFrom, snapA = uSnapAlphaFrom;
  // The opening floor may sit on a scaled-down lattice; the other scenes use the hero's own.
  float pitch = uPitchFrom;
  vec2 goff = uGridOffFrom;
  Pt P = A;
  if (uProgress > 0.0) {
    float lp = clamp((uProgress - aRand.x * 0.42) / 0.58, 0.0, 1.0);
    float e = lp * lp * lp * (lp * (lp * 6.0 - 15.0) + 10.0);
    Pt Bp = evalShape(uTo, aTo, aToMeta, aRand, t);
    bool dustB = aToMeta.x < 0.5;
    vec3 pb = dustB ? Bp.p : (uXTo * vec4(Bp.p, 1.0)).xyz;
    float travel = min(length(pb - p), 4.0) / 4.0;
    float sw = sin(e * 3.14159);
    p = mix(p, pb, e);
    p += swirl(p * 0.45 + aRand.yzw * 3.0, t) * sw * uSwirl * (0.15 + travel);
    fit = mix(fit, dustB ? 1.0 : uFitTo, e);
    snap = mix(uSnapFrom, uSnapTo, e);
    snapA = mix(uSnapAlphaFrom, uSnapAlphaTo, e);
    pitch = mix(uPitchFrom, uPitchTo, e);
    goff = mix(uGridOffFrom, uGridOffTo, e);
    P.glow = mix(A.glow, Bp.glow, e) + sw * 0.2 * travel;
    P.hue = mix(A.hue, Bp.hue, e);
    P.alpha = mix(A.alpha, Bp.alpha, e);
    P.size = mix(A.size, Bp.size, e);
    P.soft = mix(A.soft, Bp.soft, e);
    P.mute = mix(A.mute, Bp.mute, e);
    P.ink = mix(A.ink, Bp.ink, e);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = max(-mv.z, 0.5);
  vec4 clip = projectionMatrix * mv;
  // Snap to the lattice that shares the stage grid's origin, in device pixels.
  if (snap > 0.001 && clip.w > 0.0) {
    vec2 px = (clip.xy / clip.w * 0.5 + 0.5) * uRes;
    vec2 q = (floor((px - goff) / pitch) + 0.5) * pitch + goff;
    px = mix(px, q, snap);
    clip.xy = (px / uRes * 2.0 - 1.0) * clip.w;
  }
  gl_Position = clip;

  // Depth of field only for free points; snapped points are uniform tiles.
  float coc = abs(depth - uFocus) * uDof * (1.0 - snap);
  float sizeW = uSize * P.size * pow(fit, 0.55) * (1.0 + coc * 1.6);
  float freeSize = clamp(sizeW * uPx / depth, 1.0, 72.0);
  gl_PointSize = mix(freeSize, max(1.5, pitch * 0.72 * P.size), snap);
  float fade = 1.0 - smoothstep(13.0, 30.0, depth) * 0.9;
  float a = P.alpha * uAlpha * fade / (1.0 + coc * coc * 3.0) * mix(1.0, snapA, snap);
  float g = clamp(P.glow, 0.0, 1.0);
  vec3 col = mix(uAccent, uAccent2, clamp(P.hue, 0.0, 1.0));
  col = mix(col, uMuted, clamp(P.mute, 0.0, 1.0));
  col = mix(col, uInk, clamp(P.ink + g * mix(0.65, 0.6, uLight) * mix(1.0, 0.6, snap), 0.0, 1.0));
  a *= 1.0 + g * mix(0.6, 0.35, uLight);
  vColor = col;
  vAlpha = a;
  vSoft = clamp(max(P.soft, coc * 0.9), 0.0, 1.0) * (1.0 - snap);
  vSquare = snap;
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vSoft;
varying float vSquare;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float dr = length(c);
  float ds = max(abs(c.x), abs(c.y));
  float d = mix(dr, ds, vSquare);
  if (d > 1.0) discard;
  float disc = 1.0 - smoothstep(mix(0.42, 0.0, vSoft), 1.0, dr);
  float core = exp(-dr * dr * 5.0);
  float round_ = mix(disc * 0.78 + core * 0.22, core * 0.9, vSoft);
  float tile = 1.0 - smoothstep(0.78, 1.0, ds);
  float a = clamp(vAlpha * mix(round_, tile, vSquare), 0.0, 1.0);
  // Premultiplied, so the transparent canvas composites over the stage's grid.
  gl_FragColor = vec4(vColor * a, a);
}
`;

/* ========== D's simulations: entities only, written to the data texture ========== */

// Minimum-cost matching of `rows` items to distinct columns (rows <= cols <= 10),
// by dynamic programming over column subsets. Returns the column per row.
function bestMatch(cost, rows, cols) {
  const full = 1 << cols, INF = 1e9;
  let dp = new Float64Array(full).fill(INF);
  dp[0] = 0;
  const choice = [];
  for (let i = 0; i < rows; i++) {
    const nd = new Float64Array(full).fill(INF), ch = new Int8Array(full).fill(-1);
    for (let m = 0; m < full; m++) {
      if (dp[m] >= INF) continue;
      for (let o = 0; o < cols; o++) {
        if (m & (1 << o)) continue;
        const nm = m | (1 << o), v = dp[m] + cost[i][o];
        if (v < nd[nm]) { nd[nm] = v; ch[nm] = o; }
      }
    }
    choice.push(ch);
    dp = nd;
  }
  let bm = -1, best = INF;
  for (let m = 0; m < full; m++) if (dp[m] < best) { best = dp[m]; bm = m; }
  const out = new Array(rows).fill(-1);
  for (let i = rows - 1; i >= 0 && bm >= 0; i--) { const o = choice[i][bm]; out[i] = o; bm ^= 1 << o; }
  return out;
}

function makeStateSim(ctx) {
  const slot = S.STATE;
  const rr = mulberry32(11);
  const nS = N_STATES, nE = SEDGE.length;
  const edgeTo = (a, b) => SEDGE.findIndex((e) => e[0] === a && e[1] === b);
  const nextOf = (a) => SEDGE.filter((e) => e[0] === a).map((e) => e[1]);
  const st = {
    cur: 0, mode: "dwell", edge: -1, s: 0, timer: 1.2, queued: -1, hover: -1, forced: -1, msg: null, lastUser: -1e9,
    nodeEm: new Float32Array(nS).fill(0.5), edgeEm: new Float32Array(nE).fill(0.42), flash: new Float32Array(nS),
  };
  let ui = null;
  const from = () => (st.mode === "move" ? SEDGE[st.edge][1] : st.cur);
  function autoNext(c) {
    const r = rr();
    if (c === 0) return r < 0.18 ? 6 : 1;
    if (c === 1) return r < 0.1 ? 0 : 2;
    if (c === 5) return r < 0.25 ? 1 : r < 0.35 ? 6 : 0;
    if (c === 6) return 0;
    return c + 1;
  }
  function begin(target) {
    const e = edgeTo(st.cur, target);
    if (e < 0) return false;
    if (!ctx.live) { st.cur = target; st.mode = "dwell"; st.edge = -1; st.s = 0; }
    else { st.mode = "move"; st.edge = e; st.s = 0; }
    dbg("state", STATES[st.cur], "to", STATES[target]);
    sync();
    return true;
  }
  function request(target) {
    const now = ctx.now();
    st.lastUser = now;
    const f = from();
    if (target === f) { st.msg = { node: target, text: st.mode === "move" ? COPY.stateOnItsWay : COPY.stateAlreadyHere, until: now + 1.6 }; ctx.wake(1.7); return; }
    if (edgeTo(f, target) < 0) {
      st.flash[target] = 1;
      st.msg = { node: target, text: COPY.stateNotAllowed + STATES[f], until: now + 1.8, refused: true };
      console.info("[stage] state machine: " + STATES[target] + " refused from " + STATES[f]);
      ctx.wake(1.9);
      return;
    }
    console.info("[stage] state machine: " + STATES[f] + " to " + STATES[target] + " (visitor)");
    st.msg = null;
    if (st.mode === "move") st.queued = target;
    else begin(target);
  }
  function update(dt, active) {
    const now = ctx.now();
    if (ctx.live && active) {
      if (st.mode === "move") {
        st.s += dt / 1.15;
        if (st.s >= 1) { st.cur = SEDGE[st.edge][1]; st.mode = "dwell"; st.edge = -1; st.s = 0; st.timer = 0.85; sync(); }
      } else {
        st.timer -= dt;
        if (st.timer <= 0) {
          if (st.queued >= 0) { const q = st.queued; st.queued = -1; begin(q); }
          else if (now - st.lastUser > 6) begin(autoNext(st.cur));
          else st.timer = 0.25;
        }
      }
    }
    const hv = st.forced >= 0 ? st.forced : st.hover;
    const nx = hv >= 0 ? nextOf(hv) : [];
    const k = ctx.live ? 1 - Math.exp(-dt * 10) : 1;
    const msgOn = st.msg && now < st.msg.until;
    for (let i = 0; i < nS; i++) {
      const tgt = hv >= 0 ? (i === hv ? 1 : nx.includes(i) ? 0.78 : 0.2) : i === st.cur ? 0.9 : 0.5;
      st.nodeEm[i] += (tgt - st.nodeEm[i]) * k;
      if (ctx.live) st.flash[i] *= Math.exp(-dt * 2.5);
      else st.flash[i] = msgOn && st.msg.node === i && st.msg.refused ? 1 : 0;
    }
    for (let e = 0; e < nE; e++) {
      const tgt = hv >= 0 ? (SEDGE[e][0] === hv ? 1 : 0.07) : e === st.edge ? 0.95 : 0.42;
      st.edgeEm[e] += (tgt - st.edgeEm[e]) * k;
    }
    if (st.msg && !msgOn) st.msg = null;
  }
  function write() {
    for (let i = 0; i < nS; i++) {
      const n = SNODE[i];
      ctx.setD(i, ROW.SNODE, n[0], n[1], n[2], st.nodeEm[i]);
      ctx.setD(i, ROW.SNODE2, st.flash[i], i === st.cur && st.mode === "dwell" ? 1 : 0, 0, 0);
    }
    for (let e = 0; e < nE; e++) ctx.setD(e, ROW.SEDGE, SEDGE[e][0], SEDGE[e][1], SBEND, st.edgeEm[e]);
    ctx.setD(0, ROW.GLOB, st.mode === "move" ? 0 : 1, Math.max(st.edge, 0), easeInOut(clamp(st.s, 0, 1)), st.cur);
  }
  function hover(sx, sy) {
    let best = -1, bd = 34 * 34;
    for (let i = 0; i < nS; i++) {
      const p = ctx.project(slot, SNODE[i]);
      if (!p.ok) continue;
      const d2 = (p.x - sx) ** 2 + (p.y - sy) ** 2;
      if (d2 < bd) { bd = d2; best = i; }
    }
    st.hover = best;
    return best >= 0 ? "pointer" : null;
  }
  function labels(out) {
    const hv = st.forced >= 0 ? st.forced : st.hover;
    const nx = hv >= 0 ? nextOf(hv) : [];
    SNODE.forEach((n, i) => out.push({ id: "s" + i, text: STATES[i], p: [n[0], n[1] + 0.4, n[2]], cls: i === from() || i === hv || nx.includes(i) ? "on" : "" }));
    if (st.msg) { const n = SNODE[st.msg.node]; out.push({ id: "smsg", text: st.msg.text, p: [n[0], n[1] - 0.4, n[2]], cls: "tip", anchor: "down" }); }
  }
  function sync() {
    if (!ui) return;
    const f = from();
    const hadFocus = ui.contains(document.activeElement);
    ui.replaceChildren(
      h("span", null, st.mode === "move" ? COPY.stateHeading : COPY.stateNow, h("strong", { text: STATES[f] }), COPY.stateNext),
      ...nextOf(f).map((i) => h("button", { class: "ctl ctl--small", type: "button", text: STATES[i], on: { click: () => { request(i); ctx.render(); } } })));
    if (hadFocus) { const b = ui.querySelector("button"); if (b) b.focus(); }
  }
  function controls(host) {
    if (!host) return;
    ui = h("p", { class: "stage-readout", style: "display:flex;flex-wrap:wrap;align-items:center;gap:6px" });
    host.append(ui);
    sync();
  }
  return {
    slot, update, write, hover, labels, controls,
    clearHover() { st.hover = -1; },
    click() { if (st.hover >= 0) { request(st.hover); return true; } return false; },
    request, setHover(i) { st.forced = i; },
  };
}

function makeSchedSim(ctx) {
  const slot = S.SCHED;
  const G = GANTT;
  const rr = mulberry32(31);
  const rows = Array.from({ length: G.ROWS }, () => []);
  const slots = new Array(G.SLOTS).fill(null);
  let T = 0, nextOrder = 1001, hover = null, inChart = false, note = null, ui = null;
  const mk = (type, dur, order, gap = 0) => ({ type, dur, order, gap, start: 0, disp: 0, slot: -1, row: 0, alpha: 1, fresh: -1e9 });
  const job = (order) => [mk(0, 0.65 + rr() * 0.5, order), mk(1, 0.6 + rr() * 0.45, order), mk(0, 0.65 + rr() * 0.5, order), mk(2, 0.45 + rr() * 0.3, order)];
  const charge = () => [mk(0, 0.5 + rr() * 0.25, 0), mk(3, 1.4 + rr() * 0.7, 0)];
  const end = (q) => (q.length ? q[q.length - 1].start + q[q.length - 1].dur : T);
  function append(q, tasks, gap) {
    let s = q.length ? end(q) + gap : T - 2.6 + rr() * 1.4;
    tasks[0].gap = q.length ? gap : 0;
    for (const tk of tasks) { tk.start = tk.disp = s; s += tk.dur; q.push(tk); }
  }
  const nextTasks = () => (rr() < 0.12 ? charge() : job(nextOrder++));
  rows.forEach((q) => { while (end(q) < T + 6.5) append(q, nextTasks(), rr() < 0.35 ? 0.1 + rr() * 0.25 : 0); });

  function addOrder() {
    const now = ctx.now();
    let r = 0;
    for (let i = 1; i < G.ROWS; i++) if (end(rows[i]) < end(rows[r])) r = i;
    const q = rows[r];
    // The new order goes to the robot that frees up first, right after the task it is running.
    let idx = q.findIndex((tk) => tk.start + tk.dur > T);
    if (idx < 0) idx = q.length;
    else if (q[idx].start <= T) idx += 1;
    const id = nextOrder++;
    const tasks = job(id);
    let s = Math.max(idx > 0 ? q[idx - 1].start + q[idx - 1].dur : T, T);
    for (const tk of tasks) { tk.start = tk.disp = s; s += tk.dur; tk.fresh = now; tk.alpha = ctx.live ? 0 : 1; }
    q.splice(idx, 0, ...tasks);
    for (let i = idx + tasks.length; i < q.length; i++) q[i].start = q[i - 1].start + q[i - 1].dur + q[i].gap;
    if (!ctx.live) q.forEach((tk) => (tk.disp = tk.start));
    note = { text: `${COPY.schedOrder} ${id} on R${r + 1}`, tk: tasks[1], until: now + 2.6 };
    if (ui) ui.textContent = cap(COPY.schedOrder) + " " + id + COPY.schedWentTo[0] + "R" + (r + 1) + COPY.schedWentTo[1];
    ctx.wake(2.7);
    console.info("[stage] schedule: order " + id + " to R" + (r + 1));
  }
  function update(dt, active) {
    const now = ctx.now();
    if (ctx.live && active) T += dt * G.SPEED;
    const k = ctx.live ? 1 - Math.exp(-dt * 5) : 1;
    rows.forEach((q, r) => {
      while (q.length && q[0].start + q[0].dur < T - 2.4) { const tk = q.shift(); if (tk.slot >= 0) slots[tk.slot] = null; }
      if (ctx.live && active && end(q) < T + 5.4) append(q, nextTasks(), rr() < 0.35 ? 0.1 + rr() * 0.25 : 0);
      for (const tk of q) {
        tk.row = r;
        tk.disp += (tk.start - tk.disp) * k;
        tk.alpha = Math.min(1, tk.alpha + (ctx.live ? dt * 2.5 : 1));
        const x0 = G.NOWX + (tk.disp - T);
        const vis = x0 + tk.dur > -3.55 && x0 < 3.4;
        if (vis && tk.slot < 0) { const f = slots.indexOf(null); if (f >= 0) { slots[f] = tk; tk.slot = f; } }
        else if (!vis && tk.slot >= 0) { slots[tk.slot] = null; tk.slot = -1; }
      }
    });
    if (note && now > note.until) note = null;
  }
  function write() {
    const now = ctx.now();
    for (let i = 0; i < G.SLOTS; i++) {
      const tk = slots[i];
      if (!tk) { ctx.setD(i, ROW.BAR, 0, 0, 0, 0); ctx.setD(i, ROW.BAR2, 0, 0, 0, 0); continue; }
      ctx.setD(i, ROW.BAR, tk.row, G.NOWX + (tk.disp - T), tk.dur, tk.type);
      ctx.setD(i, ROW.BAR2, tk.alpha, Math.max(0, 1 - (now - tk.fresh) / 2.4), tk === hover ? 1 : 0, 0);
    }
  }
  function hoverAt(sx, sy) {
    hover = null; inChart = false;
    const p = ctx.planeHit(slot, sx, sy, "z", 0);
    if (!p) return null;
    inChart = p.x > G.X0 - 0.5 && p.x < G.X1 && p.y > -2.15 && p.y < 2.15;
    if (!inChart) return null;
    const r = Math.round(2.5 - p.y / 0.62);
    if (r >= 0 && r < G.ROWS && Math.abs(p.y - gRowY(r)) < G.BAR_H / 2 + 0.06) {
      for (const tk of rows[r]) {
        const x0 = G.NOWX + (tk.disp - T);
        if (tk.slot >= 0 && p.x >= x0 && p.x <= x0 + tk.dur) { hover = tk; break; }
      }
    }
    return "pointer";
  }
  function labels(out) {
    for (let r = 0; r < G.ROWS; r++) out.push({ id: "g" + r, text: "R" + (r + 1), p: [G.X0 - 0.2, gRowY(r), 0], anchor: "left" });
    out.push({ id: "gnow", text: COPY.schedNow, p: [G.NOWX, 2.16, 0], cls: "on" });
    out.push({ id: "glater", text: COPY.schedLater, p: [G.X1 - 0.1, -2.12, 0], anchor: "down" });
    const tip = (id, tk, text) => out.push({ id, text, p: [G.NOWX + (tk.disp - T) + tk.dur / 2, gRowY(tk.row) + G.BAR_H / 2 + 0.06, 0.05], cls: "tip" });
    if (hover) tip("gtip", hover, `R${hover.row + 1}: ${TASK[hover.type]}${hover.order ? `, ${COPY.schedOrder} ${hover.order}` : ""}`);
    else if (note) tip("gnote", note.tk, note.text);
  }
  function controls(host) {
    if (!host) return;
    const sw = (type, name) => h("li", null, h("i", { class: "sw sw-" + type, "aria-hidden": "true" }), name);
    host.append(
      h("button", { class: "ctl", type: "button", text: COPY.addOrder, on: { click: () => { addOrder(); ctx.render(); } } }),
      h("ul", { class: "legend", "aria-label": COPY.tasksLabel }, ...TASK.map((name, i) => sw(TASK_CLASS[i], name))));
    ui = h("span", { class: "stage-readout", "aria-live": "polite" });
    host.append(ui);
  }
  return {
    slot, update, write, labels, controls, addOrder,
    hover: hoverAt,
    clearHover() { hover = null; inChart = false; },
    click() { if (inChart) { addOrder(); return true; } return false; },
  };
}

function makeAssignSim(ctx) {
  const slot = S.ASSIGN;
  const rr = mulberry32(57);
  const robots = AS.ROBOTS.map(([x, z]) => ({ x, z, px: x, pz: z, nx: x, nz: z, swap: 1, act: 0, target: -1 }));
  const orders = Array.from({ length: AS.SLOTS }, () => ({ alive: false, x: 0, z: 0, alpha: 0, born: 0, hl: 0, assigned: false }));
  let seq = 0, lastUser = -1e9, lastAuto = 0, hoverO = -1, dragO = -1, lastSolve = 0, onFloor = false, ui = null;
  const dist = (r, o) => Math.hypot(r.x - o.x, r.z - o.z);
  function spot() {
    for (let i = 0; i < 40; i++) {
      const x = (rr() * 2 - 1) * (AS.W - 0.35), z = (rr() * 2 - 1) * (AS.H - 0.3);
      if (robots.every((r) => Math.hypot(r.x - x, r.z - z) > 0.6) && orders.every((o) => !o.alive || Math.hypot(o.x - x, o.z - z) > 0.5)) return [x, z];
    }
    return [(rr() * 2 - 1) * 2, (rr() * 2 - 1) * 1.2];
  }
  function spawn(x, z) {
    const alive = orders.filter((o) => o.alive);
    if (alive.length >= AS.MAX) alive.reduce((a, b) => (a.born < b.born ? a : b)).alive = false;
    let k = orders.findIndex((o) => !o.alive && o.alpha < 0.05);
    if (k < 0) k = orders.findIndex((o) => !o.alive);
    Object.assign(orders[k], { alive: true, x, z, born: ++seq, alpha: ctx.live ? 0 : 1 });
    return k;
  }
  function solve() {
    const alive = orders.map((o, i) => (o.alive ? i : -1)).filter((i) => i >= 0);
    const R = robots.length, O = alive.length;
    const cm = robots.map((r) => alive.map((k) => dist(r, orders[k])));
    const assign = new Array(R).fill(-1);
    if (O >= R) bestMatch(cm, R, O).forEach((o, ri) => (assign[ri] = o));
    else if (O > 0) bestMatch(alive.map((_, oi) => robots.map((_, ri) => cm[ri][oi])), O, R).forEach((ri, oi) => { if (ri >= 0) assign[ri] = oi; });
    // Baseline for the readout: orders in arrival order each take the nearest free robot.
    const free = new Set(robots.map((_, i) => i));
    let greedy = 0;
    alive.slice().sort((a, b) => orders[a].born - orders[b].born).forEach((k) => {
      let br = -1, bd = Infinity;
      free.forEach((ri) => { const d = dist(robots[ri], orders[k]); if (d < bd) { bd = d; br = ri; } });
      if (br >= 0) { free.delete(br); greedy += bd; }
    });
    let best = 0;
    orders.forEach((o) => (o.assigned = false));
    robots.forEach((r, ri) => {
      const k = assign[ri] >= 0 ? alive[assign[ri]] : -1;
      if (k >= 0) { best += dist(r, orders[k]); orders[k].assigned = true; }
      if (k !== r.target) {
        const e = ease(r.swap);
        r.px += (r.nx - r.px) * e; r.pz += (r.nz - r.pz) * e;
        r.nx = k >= 0 ? orders[k].x : r.x; r.nz = k >= 0 ? orders[k].z : r.z;
        r.swap = ctx.live ? 0 : 1;
        r.target = k;
      }
    });
    if (ui) ui.replaceChildren(COPY.assignTravel[0], h("strong", { text: greedy.toFixed(1) }), COPY.assignTravel[1], h("strong", { text: best.toFixed(1) }), COPY.assignTravel[2]);
  }
  function userOrder(x, z) {
    lastUser = ctx.now();
    spawn(clamp(x, -AS.W + 0.15, AS.W - 0.15), clamp(z, -AS.H + 0.15, AS.H - 0.15));
    solve();
    console.info("[stage] assignment: order added, plan re-solved");
  }
  for (let i = 0; i < 7; i++) { const [x, z] = spot(); spawn(x, z); }
  orders.forEach((o) => { if (o.alive) o.alpha = 1; });
  solve();
  robots.forEach((r) => { r.swap = 1; r.px = r.nx; r.pz = r.nz; r.act = r.target >= 0 ? 1 : 0; });

  function update(dt, active) {
    const now = ctx.now();
    const k = ctx.live ? 1 - Math.exp(-dt * 5) : 1;
    robots.forEach((r) => {
      r.swap = ctx.live ? Math.min(1, r.swap + dt / 0.9) : 1;
      if (r.target >= 0) { r.nx = orders[r.target].x; r.nz = orders[r.target].z; }
      r.act += ((r.target >= 0 ? 1 : 0) - r.act) * k;
    });
    orders.forEach((o, i) => {
      o.alpha += ((o.alive ? 1 : 0) - o.alpha) * k;
      o.hl += ((i === hoverO || i === dragO ? 1 : 0) - o.hl) * k;
    });
    if (ctx.live && active && dragO < 0 && now - lastUser > 7 && now - lastAuto > 4.5) {
      // Idle: the oldest order is served and a new one arrives, so the plan keeps re-solving.
      lastAuto = now;
      const alive = orders.filter((o) => o.alive);
      if (alive.length) alive.reduce((a, b) => (a.born < b.born ? a : b)).alive = false;
      const [x, z] = spot();
      spawn(x, z);
      solve();
    }
  }
  function write() {
    robots.forEach((r, j) => {
      ctx.setD(j, ROW.AROB, r.x, r.z, r.swap, r.act);
      ctx.setD(j, ROW.AROB2, r.px, r.pz, r.nx, r.nz);
    });
    orders.forEach((o, q) => {
      ctx.setD(q, ROW.AORD, o.x, o.z, o.alpha, o.assigned ? 1 : 0);
      ctx.setD(q, ROW.AORD2, o.hl, 0, 0, 0);
    });
  }
  function hover(sx, sy) {
    hoverO = -1; onFloor = false;
    let bd = 26 * 26;
    orders.forEach((o, i) => {
      if (!o.alive) return;
      const p = ctx.project(slot, [o.x, 0.08, o.z]);
      if (!p.ok) return;
      const d2 = (p.x - sx) ** 2 + (p.y - sy) ** 2;
      if (d2 < bd) { bd = d2; hoverO = i; }
    });
    if (hoverO >= 0) return "grab";
    const p = ctx.planeHit(slot, sx, sy, "y", 0);
    onFloor = !!p && Math.abs(p.x) < AS.W && Math.abs(p.z) < AS.H;
    return onFloor ? "crosshair" : null;
  }
  function labels(out) {
    robots.forEach((r, i) => out.push({ id: "a" + i, text: "R" + (i + 1), p: [r.x, 0.62, r.z], cls: r.target >= 0 ? "on" : "" }));
    orders.forEach((o, i) => { if (o.alive && !o.assigned) out.push({ id: "aw" + i, text: COPY.assignWaiting, p: [o.x, 0.3, o.z] }); });
  }
  function controls(host) {
    if (!host) return;
    host.append(h("button", { class: "ctl", type: "button", text: COPY.addOrder, on: { click: () => { const [x, z] = spot(); userOrder(x, z); ctx.render(); } } }));
    ui = h("span", { class: "stage-readout", "aria-live": "polite" });
    host.append(ui);
    solve();
  }
  return {
    slot, update, write, hover, labels, controls, userOrder,
    clearHover() { hoverO = -1; onFloor = false; },
    press() { if (hoverO < 0) return false; dragO = hoverO; lastUser = ctx.now(); return true; },
    drag(sx, sy) {
      const p = ctx.planeHit(slot, sx, sy, "y", 0);
      if (!p || dragO < 0) return;
      const o = orders[dragO];
      o.x = clamp(p.x, -AS.W + 0.15, AS.W - 0.15);
      o.z = clamp(p.z, -AS.H + 0.15, AS.H - 0.15);
      const now = ctx.now();
      if (now - lastSolve > 0.06) { solve(); lastSolve = now; }
    },
    release(moved) { if (dragO >= 0) { solve(); dragO = -1; lastUser = ctx.now(); if (moved) console.info("[stage] assignment: order moved, plan re-solved"); } },
    click(sx, sy) {
      if (hoverO >= 0 || !onFloor) return false;
      const p = ctx.planeHit(slot, sx, sy, "y", 0);
      if (p) userOrder(p.x, p.z);
      return !!p;
    },
  };
}

function makeRustSim(ctx) {
  const slot = S.RUST;
  const nodes = RUST_POS.map((p, k) => ({ name: COPY.subsystems[k], p, mig: 0, target: 0, delay: 0, hl: 0 }));
  let hover = -1, lastUser = -1e9, lastAuto = 0, ui = null, eps = -1, btnAll = null;
  function migrate(k, delay = 0) {
    const n = nodes[k];
    if (n.target === 1) return;
    n.target = 1; n.delay = ctx.live ? delay : 0;
    lastUser = ctx.now();
    console.info("[stage] event bus: migrate " + n.name + " to Rust");
  }
  function migrateAll() { let d = 0; nodes.forEach((n, k) => { if (n.target === 0) { migrate(k, d); d += 0.3; } }); }
  function reset() { nodes.forEach((n) => { n.target = 0; n.delay = 0; }); lastUser = ctx.now(); console.info("[stage] event bus: reset to Python"); }
  function update(dt, active) {
    const now = ctx.now();
    const k = ctx.live ? 1 - Math.exp(-dt * 8) : 1;
    nodes.forEach((n, i) => {
      if (n.delay > 0) n.delay -= dt;
      else if (ctx.live) n.mig = clamp(n.mig + (Math.sign(n.target - n.mig) * dt) / (n.target ? 1.3 : 0.7), 0, 1);
      else n.mig = n.target;
      n.hl += ((i === hover ? 1 : 0) - n.hl) * k;
    });
    if (ctx.live && active && now - lastUser > 6 && now - lastAuto > 2.6) {
      const n = nodes.find((x) => x.target === 0);
      if (n) { n.target = 1; lastAuto = now; }
    }
    // A toy rate: each subsystem adds a little in Python and more once it is in Rust.
    const e = Math.round(nodes.reduce((s, n) => s + 40 + 110 * n.mig, 0) / 10) * 10;
    if (e !== eps) { eps = e; if (ui) ui.replaceChildren(COPY.eventsPerSecond, h("strong", { text: String(e) })); }
    if (btnAll) btnAll.disabled = nodes.every((n) => n.target === 1);
  }
  function write() {
    nodes.forEach((n, k) => { ctx.setD(k, ROW.RNODE, n.p[0], n.p[1], n.p[2], n.mig); ctx.setD(k, ROW.RNODE2, n.hl, 0, 0, 0); });
    const avg = nodes.reduce((s, n) => s + n.mig, 0) / nodes.length;
    ctx.setD(2, ROW.GLOB, 0.35 + 0.9 * avg, avg, 0, 0);
  }
  function hoverAt(sx, sy) {
    hover = -1;
    let bd = 50 * 50;
    nodes.forEach((n, k) => {
      const p = ctx.project(slot, n.p);
      if (!p.ok) return;
      const d2 = (p.x - sx) ** 2 + (p.y - sy) ** 2;
      if (d2 < bd) { bd = d2; hover = k; }
    });
    return hover >= 0 && nodes[hover].target === 0 ? "pointer" : null;
  }
  function labels(out) {
    nodes.forEach((n, k) => {
      // Labels sit on the outer side of each subsystem, away from the spokes.
      const [x, y, z] = n.p;
      const side = Math.abs(x) < 1 && y > 0 ? "up" : "down";
      const p = [x, y + (side === "up" ? 0.55 : -0.55), z];
      out.push({ id: "r" + k, text: n.name, sub: n.mig > 0.5 ? COPY.rust : COPY.python, p, anchor: side, cls: n.mig > 0.5 || k === hover ? "on" : "" });
    });
    out.push({ id: "rbus", text: COPY.bus, p: [0, 0, 0], anchor: "mid" });
  }
  function controls(host) {
    if (!host) return;
    btnAll = h("button", { class: "ctl", type: "button", text: COPY.migrateAll, on: { click: () => { migrateAll(); ctx.render(); } } });
    host.append(btnAll, h("button", { class: "ctl ctl--quiet", type: "button", text: COPY.reset, on: { click: () => { reset(); ctx.render(); } } }));
    ui = h("span", { class: "stage-readout" });
    host.append(ui);
  }
  return {
    slot, update, write, labels, controls, migrate, migrateAll, reset,
    hover: hoverAt,
    clearHover() { hover = -1; },
    click() { if (hover >= 0) { migrate(hover); return true; } return false; },
  };
}

// The hero floor, flat (slot 0) or in 3D (slot 5). Entity data comes from the shared FloorSim.
function makeFloorView(ctx, slot) {
  const flat = slot === S.FLOOR;
  let onFloor = false, hit = null, ui = null, lastUi = 0, latest = null;
  function hover(sx, sy) {
    const G = ctx.floorGeom();
    const p = ctx.planeHit(slot, sx, sy, "y", 0);
    const w = G && (flat ? G.flat : G.sim);
    onFloor = !!p && !!w && p.x > w.c0 && p.z > w.r0 && p.x < w.c1 + 1 && p.z < w.r1 + 1;
    hit = onFloor ? p : null;
    return onFloor ? "crosshair" : null;
  }
  function click(sx, sy) {
    hover(sx, sy);
    if (!hit) return false;
    const o = FS.placeAtCell(hit.x, hit.z);
    if (o) latest = o.id;
    ctx.render();
    return true;
  }
  function labels(out) {
    if (flat) return;
    const G = ctx.floorGeom();
    if (!G) return;
    const F = G.F, T = F.type, K = F.kinds;
    // One label per kind of thing, placed on real cells of this layout.
    let rack = null;
    const w = G.sim;
    const inside = (x, z) => x > w.c0 + 0.5 && x < w.c1 + 0.5 && z > w.r0 + 0.5 && z < w.r1 + 0.5;
    for (let r = w.r0; r <= w.r1 && !rack; r++) for (let c = Math.floor((w.c0 + w.c1) / 2); c <= w.c1; c++) if (T[r * F.cols + c] === K.RACK) { rack = [c + 0.5, 1.75, r + 0.5]; break; }
    if (rack) out.push({ id: "frack", text: COPY.floorTags.rack, p: rack });
    const st = F.stations.find((s) => inside(s.c0 + s.w / 2, s.r0 + s.h / 2));
    if (st) out.push({ id: "fst", text: COPY.floorTags.station, p: [st.c0 + st.w / 2, 0.7, st.r0 + st.h / 2], anchor: "left" });
    const rs = ctx.floorRobots();
    // The busy robot nearest the middle of the window, so its label stays clear of the stations.
    const mx = (w.c0 + w.c1) / 2, mz = (w.r0 + w.r1) / 2;
    const mover = rs.filter((r) => !r.idle && inside(r.x, r.z)).sort((a, b) => Math.hypot(a.x - mx, a.z - mz) - Math.hypot(b.x - mx, b.z - mz))[0];
    if (mover) out.push({ id: "fbot", text: COPY.floorTags.robot, p: [mover.x, 0.75, mover.z] });
    const os = ctx.floorOrders();
    const mine = os.find((o) => o.id === latest) || os.find((o) => o.user);
    if (mine && mine.alpha > 0.05 && inside(mine.x, mine.z)) out.push({ id: "ford", text: COPY.floorTags.order, p: [mine.x, 0.9, mine.z], cls: "on" });
  }
  function readout() {
    if (!ui) return;
    const now = ctx.now();
    if (now - lastUi < 0.4) return;
    lastUi = now;
    const s = FS.stats();
    if (!s) return;
    const kv = (label, value) => [label + " ", h("strong", { text: value }), "   "];
    const W = COPY.floor;
    if (flat) ui.replaceChildren(...kv(W.fleet, String(s.fleet)), ...kv(W.open, String(s.open)), ...kv(W.placed, String(s.placed)));
    else ui.replaceChildren(...kv(W.clock, s.clock), ...kv(W.seed, String(s.seed)), ...kv(W.generated, String(s.generated)));
  }
  function controls(host) {
    if (!host) return;
    host.append(h("button", { class: "ctl", type: "button", text: COPY.addOrder, on: { click: () => {
      const o = FS.placeRandom();
      if (o) latest = o.id;
      lastUi = 0; readout(); ctx.render();
    } } }));
    ui = h("span", { class: "stage-readout", style: "white-space:pre" });
    host.append(ui);
    readout();
  }
  return {
    slot, labels, controls, click, hover,
    update() { readout(); },
    refresh() { lastUi = -1; readout(); },
    write() {},
    clearHover() { onFloor = false; hit = null; },
  };
}

async function start() {
  const canvas = $("#stage-canvas");
  const small = Math.min(innerWidth, innerHeight) < 640 || COARSE;
  const N = small ? 16384 : 32768;
  const live = !REDUCED;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const nowS = () => performance.now() / 1000;

  let dead = false;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 0);
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    console.error("[stage] shader compile failed", gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs));
    dead = true;
    stopLoop();
    api.fail("shader compile failed");
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 120);
  camera.position.set(0, 0, CAM_Z);
  camera.updateMatrixWorld();

  /* Per-point constants: rank decides structure vs dust, key orders points left to right. */
  const rnd = mulberry32(20211101);
  const rank = new Uint32Array(N);
  const perm = Array.from({ length: N }, (_, i) => i);
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  perm.forEach((p, r) => { rank[p] = r; });
  const key = new Float32Array(N);
  const aRand = new Float32Array(N * 4);
  const dustHome = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    key[i] = rnd();
    aRand[i * 4] = 0.6 * key[i] + 0.4 * rnd();
    aRand[i * 4 + 1] = rnd(); aRand[i * 4 + 2] = rnd(); aRand[i * 4 + 3] = rnd();
    dustHome[i * 3] = -6 + rnd() * 12;
    dustHome[i * 3 + 1] = -4.5 + rnd() * 9;
    dustHome[i * 3 + 2] = -6 + rnd() * 7.5;
  }
  const byKey = Uint32Array.from({ length: N }, (_, i) => i).sort((a, b) => key[a] - key[b]);

  const tmpM = new THREE.Matrix4(), tmpV = new THREE.Vector3(), tmpE = new THREE.Euler();
  function arrange(B, shapeId) {
    const M = Math.min(B.count(), N);
    tmpE.set(BASE_EULER[shapeId][0], BASE_EULER[shapeId][1], 0, "XYZ");
    tmpM.makeRotationFromEuler(tmpE);
    const sk = new Float32Array(M);
    for (let j = 0; j < M; j++) {
      tmpV.set(B.pos[j * 3], B.pos[j * 3 + 1], B.pos[j * 3 + 2]).applyMatrix4(tmpM);
      sk[j] = tmpV.x + 0.12 * tmpV.y;
    }
    const order = Uint32Array.from({ length: M }, (_, j) => j).sort((a, b) => sk[a] - sk[b]);
    const pos = new Float32Array(N * 3), meta = new Float32Array(N * 4);
    let j = 0;
    for (let q = 0; q < N; q++) {
      const i = byKey[q];
      if (rank[i] < M) {
        const s = order[j++];
        pos.set(B.pos.subarray(s * 3, s * 3 + 3), i * 3);
        meta.set(B.meta.subarray(s * 4, s * 4 + 4), i * 4);
      } else {
        pos.set(dustHome.subarray(i * 3, i * 3 + 3), i * 3);
        meta[i * 4 + 1] = aRand[i * 4 + 3];
      }
    }
    return { pos, meta, M };
  }

  // Shapes are built one per task, yielding in between, so the page keeps scrolling smoothly.
  const t0 = performance.now();
  const gens = [null, genState, genSched, genAssign, genRust, null];
  const shapes = [];
  for (let id = 0; id < gens.length; id++) {
    const g = gens[id];
    shapes.push(g ? arrange(g(Math.round(N * STRUCT[id]), mulberry32(1000 + id)), id) : null);
    if (g) await yieldTask();
  }
  // Until the floor is known, both floor slots borrow the state graph.
  shapes[S.FLOOR] = shapes[S.STATE];
  shapes[S.SIM] = shapes[S.STATE];
  console.info("[stage] point shapes built in " + Math.round(performance.now() - t0) + " ms (" + N + " points)");

  /* Geometry: from set, to set, constant randoms. */
  const geo = new THREE.BufferGeometry();
  const aFrom = new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const aFromMeta = new THREE.BufferAttribute(new Float32Array(N * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const aTo = new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const aToMeta = new THREE.BufferAttribute(new Float32Array(N * 4), 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", aFrom);
  geo.setAttribute("aFromMeta", aFromMeta);
  geo.setAttribute("aTo", aTo);
  geo.setAttribute("aToMeta", aToMeta);
  geo.setAttribute("aRand", new THREE.BufferAttribute(aRand, 4));

  /* Entity data texture. */
  const data = new Float32Array(DW * DH * 4);
  const dataTex = new THREE.DataTexture(data, DW, DH, THREE.RGBAFormat, THREE.FloatType);
  dataTex.needsUpdate = true;
  const setD = (i, row, a, b, c, d) => { if (i >= DW) return; const o = (row * DW + i) * 4; data[o] = a; data[o + 1] = b; data[o + 2] = c; data[o + 3] = d; };

  const uniforms = {
    uTime: { value: 0 }, uProgress: { value: 0 },
    uFrom: { value: 0 }, uTo: { value: 1 },
    uXFrom: { value: new THREE.Matrix4() }, uXTo: { value: new THREE.Matrix4() },
    uFitFrom: { value: 1 }, uFitTo: { value: 1 },
    uPx: { value: 1000 }, uSize: { value: 0.034 }, uLight: { value: 0 },
    uSwirl: { value: 0.5 }, uFocus: { value: CAM_Z }, uDof: { value: 0.12 }, uAlpha: { value: 0.66 }, uSnapAlphaFrom: { value: 1 }, uSnapAlphaTo: { value: 1 },
    uSnapFrom: { value: 1 }, uSnapTo: { value: 1 }, uPitchFrom: { value: 4 }, uPitchTo: { value: 4 },
    uRes: { value: new THREE.Vector2(1, 1) }, uGridOffFrom: { value: new THREE.Vector2(0, 0) }, uGridOffTo: { value: new THREE.Vector2(0, 0) }, uRegion: { value: new THREE.Vector4(0, 99, 0, 99) },
    uAccent: { value: new THREE.Vector3(0.65, 0.58, 1) }, uAccent2: { value: new THREE.Vector3(0.44, 0.89, 0.82) },
    uInk: { value: new THREE.Vector3(0.93, 0.94, 1) }, uMuted: { value: new THREE.Vector3(0.61, 0.64, 0.8) },
    uData: { value: dataTex },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  scene.add(points);

  /* ========== Colors from the CSS tokens ========== */
  const cctx = document.createElement("canvas").getContext("2d");
  function rgb(css) {
    cctx.fillStyle = "#000";
    cctx.fillStyle = css || "#000";
    const v = cctx.fillStyle;
    if (v[0] === "#") return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
    const m = v.match(/[\d.]+/g) || [0, 0, 0];
    return [m[0] / 255, m[1] / 255, m[2] / 255];
  }
  const tokens = (n) => getComputedStyle(root).getPropertyValue(n).trim();
  let light = false;
  function readColors() {
    const bg = rgb(tokens("--bg"));
    uniforms.uAccent.value.fromArray(rgb(tokens("--accent")));
    uniforms.uAccent2.value.fromArray(rgb(tokens("--accent-2")));
    uniforms.uInk.value.fromArray(rgb(tokens("--ink")));
    uniforms.uMuted.value.fromArray(rgb(tokens("--muted")));
    light = tokens("--scheme") === "light" || (bg[0] + bg[1] + bg[2]) / 3 > 0.6;
    uniforms.uLight.value = light ? 1 : 0;
    // Light palettes: normal (premultiplied) blending, so dense spots go toward ink, not white.
    material.blendDst = light ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor;
    material.needsUpdate = true;
    uniforms.uAlpha.value = light ? 0.9 : 0.66;
    uniforms.uSize.value = light ? 0.03 : 0.034;
    uniforms.uDof.value = light ? 0.07 : 0.12;
    console.info("[stage] colors read: " + (light ? "light" : "dark") + " palette, accent " + tokens("--accent"));
  }
  readColors();

  /* ========== Layout: the stage view, floor frame and lattice ========== */
  let cw = 1, ch = 1, visW = 1, visH = 1, unit = 1, G = null;
  const drawSize = new THREE.Vector2();
  function resize() {
    cw = canvas.clientWidth || 1; ch = canvas.clientHeight || 1;
    renderer.setSize(cw, ch, false);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
    renderer.getDrawingBufferSize(drawSize);
    uniforms.uPx.value = drawSize.y / (2 * TAN);
    uniforms.uRes.value.set(drawSize.x, drawSize.y);
    visH = 2 * CAM_Z * TAN;
    visW = visH * camera.aspect;
    unit = visH / ch;
    rebuildFloor("resize");
    api.measure();
    requestRender();
  }
  function stageArea() { return { cx: 0, cy: 0, w: visW * 0.86, h: visH * 0.78 }; }

  /* ========== The floor shapes, rebuilt when the hero's layout or the stage's size changes ========== */
  let floorKey = "";
  function rebuildFloor(reason) {
    if (!FS.ready) return;
    const g = api.floorFrame(cw, ch);
    if (!g) return;
    G = g;
    api.setGridVars(G);
    // The lattice: pitch is cell / sub in device px; its origin is the grid's origin, in GL (bottom-up) pixels.
    const k = drawSize.x / cw;
    // Lattice per slot: pitch in device px and origin in GL (bottom-up) pixels.
    lattice[0] = { pitch: (G.cell / G.sub) * k, x: G.gx * k, y: (ch - G.gy) * k };
    const one = { pitch: (G.cell1 / G.subSim) * k, x: G.gx1 * k, y: (ch - G.gy1) * k };
    for (let i = 1; i < 6; i++) lattice[i] = one;
    applyLattice();
    uniforms.uRegion.value.set(G.sim.c0, G.sim.c1 + 1, G.sim.r0, G.sim.r1 + 1);
    const fk = [FS.version, G.cell, G.gx, G.gy, G.flat.c0, G.flat.c1, G.sim.c0, G.flat.r0, G.flat.r1, G.sim.r0, G.sim.r1, G.sub, cw, ch].join(",");
    if (fk === floorKey) return;
    floorKey = fk;
    const t1 = performance.now();
    const mask = FS.nameMask();
    const nR = Math.min(DW, FS.robots().length);
    const flatB = genFloor(Math.round(N * STRUCT[S.FLOOR]), mulberry32(2000), G, mask, nR, true);
    const simB = genFloor(Math.round(N * STRUCT[S.SIM]), mulberry32(2005), G, mask, nR, false);
    shapes[S.FLOOR] = arrange(flatB, S.FLOOR);
    shapes[S.SIM] = arrange(simB, S.SIM);
    if (seg >= 0) setSeg(seg);
    console.info("[stage] floor shapes rebuilt (" + reason + "): flat " + flatB.count() + " points, 3D " + simB.count() +
      " points, cell " + G.cell.toFixed(1) + "px (scale " + G.scale.toFixed(2) + "), lattice " + G.sub + " per cell, " + Math.round(performance.now() - t1) + " ms");
  }
  addEventListener("floor:change", (e) => {
    rebuildFloor(e.detail ? e.detail.reason : "floor change");
    if (sims) { sims.floor.refresh(); sims.sim.refresh(); }
    requestRender();
  });

  /* ========== Morph pair management ========== */
  let seg = -1;
  const lattice = Array.from({ length: 6 }, () => ({ pitch: 4, x: 0, y: 0 }));
  function applyLattice() {
    if (seg < 0) return;
    const a = lattice[seg], b = lattice[seg + 1];
    uniforms.uPitchFrom.value = a.pitch; uniforms.uGridOffFrom.value.set(a.x, a.y);
    uniforms.uPitchTo.value = b.pitch; uniforms.uGridOffTo.value.set(b.x, b.y);
  }
  function upload(attrPos, attrMeta, shape) {
    attrPos.array.set(shape.pos); attrPos.needsUpdate = true;
    attrMeta.array.set(shape.meta); attrMeta.needsUpdate = true;
  }
  function setSeg(s) {
    seg = s;
    upload(aFrom, aFromMeta, shapes[s]);
    upload(aTo, aToMeta, shapes[s + 1]);
    uniforms.uFrom.value = s;
    uniforms.uTo.value = s + 1;
    uniforms.uSnapFrom.value = SNAP[s];
    uniforms.uSnapTo.value = SNAP[s + 1];
    uniforms.uSnapAlphaFrom.value = SNAP_ALPHA[s] * (light && s > 0 && s < S.SIM ? 1.5 : 1);
    uniforms.uSnapAlphaTo.value = SNAP_ALPHA[s + 1] * (light && s + 1 > 0 && s + 1 < S.SIM ? 1.5 : 1);
    applyLattice();
    dbg("pair", NAMES[s], "to", NAMES[s + 1]);
  }

  /* Orbit: a mouse drag turns the current shape; it drifts home when left alone. */
  const orbit = { yaw: 0, pitch: 0, ty: 0, tp: 0, last: -1e9 };

  /* Per-shape transform: the flat floor is pinned 1:1 to the stage grid; the rest are fitted. */
  const xS = new THREE.Matrix4(), xT = new THREE.Matrix4(), xO = new THREE.Matrix4();
  let t = REDUCED ? 8.0 : 0;
  function shapeXform(slot, out) {
    if (slot === S.FLOOR) {
      const cell = G ? G.cell : 30, gx = G ? G.gx : 0, gy = G ? G.gy : 0;
      const s = cell * unit;
      tmpE.set(Math.PI / 2, 0, 0, "XYZ");
      out.makeRotationFromEuler(tmpE);
      out.premultiply(xS.makeScale(s, s, s));
      out.premultiply(xT.makeTranslation((gx - cw / 2) * unit, (ch / 2 - gy) * unit, 0));
      return s;
    }
    let [ex, ey] = BASE_EULER[slot];
    switch (slot) {
      case S.STATE: ey += Math.sin(t * 0.13) * 0.07; break;
      case S.SCHED: ey += Math.sin(t * 0.11) * 0.04; break;
      case S.ASSIGN: ey += Math.sin(t * 0.1) * 0.05; break;
      case S.RUST: ey += Math.sin(t * 0.1) * 0.12; break;
      case S.SIM: ey += Math.sin(t * 0.09) * 0.05; break;
      default: break;
    }
    ex += orbit.pitch; ey += orbit.yaw;
    const area = stageArea();
    tmpE.set(ex, ey, 0, "XYZ");
    out.makeRotationFromEuler(tmpE);
    let fit;
    if (slot === S.SIM) {
      // Fit the whole floor (above the hero panel) by its rotated bounding box.
      const fc0 = G ? G.sim.c0 : 0, fc1 = G ? G.sim.c1 + 1 : 30, fr0 = G ? G.sim.r0 : 0, fr1 = G ? G.sim.r1 + 1 : 20;
      out.multiply(xO.makeTranslation(-(fc0 + fc1) / 2, 0, -(fr0 + fr1) / 2));
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y, z] of [[fc0, 0, fr0], [fc1, 0, fr0], [fc0, 0, fr1], [fc1, 0, fr1], [fc0, 1.6, fr0], [fc1, 1.6, fr0], [fc0, 1.6, fr1], [fc1, 1.6, fr1]]) {
        tmpV.set(x, y, z).applyMatrix4(out);
        x0 = Math.min(x0, tmpV.x); x1 = Math.max(x1, tmpV.x); y0 = Math.min(y0, tmpV.y); y1 = Math.max(y1, tmpV.y);
      }
      // Perspective swells the near edge, so the height fit keeps some margin.
      fit = Math.min((area.w * 1.06) / (x1 - x0), (area.h * 0.98) / (y1 - y0));
      out.premultiply(xT.makeTranslation(-(x0 + x1) / 2, -(y0 + y1) / 2, 0));
    } else {
      const [nw, nh] = NOMINAL[slot];
      fit = Math.min(area.w / nw, area.h / nh);
    }
    out.premultiply(xS.makeScale(fit, fit, fit));
    out.premultiply(xT.makeTranslation(area.cx, area.cy, 0));
    return slot === S.SIM ? fit * 4.2 : fit;
  }

  /* Projection and picking in a shape's local space, with the matrices the shader uses. */
  const _sm = new THREE.Matrix4(), _mi = new THREE.Matrix4(), _pv = new THREE.Vector3(), _ro = new THREE.Vector3(), _rd = new THREE.Vector3();
  function slotMatrix(slot, out) { shapeXform(slot, out); return out.premultiply(points.matrixWorld); }
  function projectWith(M, p) {
    _pv.set(p[0], p[1], p[2]).applyMatrix4(M).project(camera);
    const ok = _pv.z > -1 && _pv.z < 1 && Math.abs(_pv.x) < 1.05 && Math.abs(_pv.y) < 1.05;
    return { x: (_pv.x + 1) * 0.5 * cw, y: (1 - _pv.y) * 0.5 * ch, ok };
  }
  function planeHit(slot, sx, sy, axis, value) {
    _mi.copy(slotMatrix(slot, _sm)).invert();
    _ro.copy(camera.position).applyMatrix4(_mi);
    _rd.set((sx / cw) * 2 - 1, -(sy / ch) * 2 + 1, 0.5).unproject(camera).applyMatrix4(_mi).sub(_ro).normalize();
    const den = _rd[axis];
    if (Math.abs(den) < 1e-6) return null;
    const tt = (value - _ro[axis]) / den;
    if (tt <= 0) return null;
    return { x: _ro.x + _rd.x * tt, y: _ro.y + _rd.y * tt, z: _ro.z + _rd.z * tt };
  }

  /* ========== Simulations ========== */
  let fRobots = [], fOrders = [];
  const ctx = {
    live,
    now: nowS,
    setD,
    project: (slot, p) => projectWith(slotMatrix(slot, _sm), p),
    planeHit,
    render: () => requestRender(),
    wake: (s) => { if (!live) setTimeout(requestRender, s * 1000); },
    floorGeom: () => G,
    floorRobots: () => fRobots,
    floorOrders: () => fOrders,
  };
  const sims = {
    floor: makeFloorView(ctx, S.FLOOR),
    state: makeStateSim(ctx), sched: makeSchedSim(ctx), assign: makeAssignSim(ctx), rust: makeRustSim(ctx),
    sim: makeFloorView(ctx, S.SIM),
  };
  const simList = Object.values(sims);
  const simAt = (slot) => simList.find((s) => s.slot === slot) || null;
  sims.floor.controls($('[data-controls="floor"]'));
  sims.state.controls($('[data-controls="state"]'));
  sims.sched.controls($('[data-controls="scheduling"]'));
  sims.assign.controls($('[data-controls="assignment"]'));
  sims.rust.controls($('[data-controls="rust"]'));
  sims.sim.controls($('[data-controls="simulation"]'));
  simList.forEach((s) => { s.update(0, false); s.write(); });

  // The shared floor simulation, written into its texture rows.
  // A zoomed-out floor can hold more robots and orders than the texture rows, so
  // only the ones inside (or near) the current floor scene's window are sent.
  function windowed(list, cap) {
    if (!G) return list.slice(0, cap);
    const w = d < 2.5 ? G.flat : G.sim;
    const out = [];
    for (const e of list) {
      if (out.length >= cap) break;
      if (e.x > w.c0 - 2 && e.x < w.c1 + 3 && e.z > w.r0 - 2 && e.z < w.r1 + 3) out.push(e);
    }
    return out;
  }
  function writeFloor(now) {
    if (!FS.ready) return;
    FS.tick(now);
    fRobots = windowed(FS.robots(), DW);
    fOrders = windowed(FS.orders(), 48);
    for (let j = 0; j < DW; j++) {
      const r = fRobots[j];
      if (r) { setD(j, ROW.FROB, r.x, r.z, r.ang, 1); setD(j, ROW.FROB2, r.tote, r.light, r.idle, 0); }
      else { setD(j, ROW.FROB, 0, 0, 0, 0); setD(j, ROW.FROB2, 0, 0, 0, 0); }
    }
    for (let q = 0; q < 48; q++) {
      const o = fOrders[q];
      if (o) {
        // On a scaled-down opening floor, orders grow a little so they stay visible on the lattice.
        const grow = G && d < 2.5 && G.scale < 1 ? 1 / Math.sqrt(G.scale) : 1;
        setD(q, ROW.FORD, o.x, o.z, o.size * grow, o.alpha);
        const birth = !REDUCED && o.age < 1.4 && o.id > 0 ? Math.max(0.001, o.age / 1.4) : 0;
        setD(q, ROW.FORD2, o.claimed, o.user, birth, 0);
      } else { setD(q, ROW.FORD, 0, 0, 0, 0); setD(q, ROW.FORD2, 0, 0, 0, 0); }
    }
    FS.stations().forEach((st, i) => setD(i, ROW.FST, st.flash, 0, 0, 0));
  }

  /* ========== Labels: HTML, projected from shape-local anchors ========== */
  const labelLayer = $("[data-stage-labels]");
  const lmap = new Map();
  const _lm = new THREE.Matrix4();
  function placeLabels() {
    const used = new Set();
    const ls = Math.round(d);
    const alpha = clamp(1 - Math.abs(d - ls) * 6, 0, 1);
    const sim = simAt(ls);
    if (sim && alpha > 0.01) {
      const specs = [];
      sim.labels(specs);
      slotMatrix(ls, _lm);
      for (const sp of specs) {
        const p = projectWith(_lm, sp.p);
        if (!p.ok) continue;
        let el = lmap.get(sp.id);
        if (!el) { el = h("span", { class: "lbl" }); labelLayer.append(el); lmap.set(sp.id, el); }
        const txt = sp.text + "|" + (sp.sub || "");
        if (el._t !== txt) {
          el._t = txt;
          el.replaceChildren(sp.text, ...(sp.sub ? [h("small", { text: sp.sub })] : []));
        }
        const cls = `lbl a-${sp.anchor || "up"} ${sp.cls || ""}`;
        if (el._c !== cls) { el._c = cls; el.className = cls; }
        el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
        el.style.opacity = alpha.toFixed(3);
        used.add(sp.id);
      }
    }
    lmap.forEach((el, id) => { if (!used.has(id) && el.style.opacity !== "0") el.style.opacity = "0"; });
  }

  /* ========== Pointer: hover, click, drag, orbit (inside the stage only) ========== */
  const ptr = { x: -1, y: -1, in: false, type: "mouse" };
  let press = null, cursor = "";
  const activeShape = () => { const s = Math.round(d); return Math.abs(d - s) < 0.12 ? s : -1; };
  const local = (e) => { const b = viewEl.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  function setCursor(c) {
    if (c === cursor) return;
    cursor = c;
    if (c) viewEl.dataset.cursor = c; else delete viewEl.dataset.cursor;
  }
  function updateHover() {
    const s = activeShape();
    const sim = simAt(s);
    simList.forEach((o) => { if (o !== sim) o.clearHover(); });
    if (press && press.dragging) return;
    if (!ptr.in || ptr.type !== "mouse" || s < 0) { if (sim) sim.clearHover(); setCursor(""); return; }
    const c = sim ? sim.hover(ptr.x, ptr.y) : null;
    setCursor(c || (s === S.FLOOR ? "" : "grab"));
  }
  viewEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const s = activeShape();
    if (s < 0) return;
    const sim = simAt(s);
    const p = local(e);
    press = { x: p.x, y: p.y, sim, mode: "tap", dragging: false, yaw0: orbit.ty, pitch0: orbit.tp };
    if (sim) {
      sim.hover(p.x, p.y);
      if (e.pointerType === "mouse" && sim.press && sim.press()) press.mode = "entity";
    }
    // Touch stays tap-only, so a finger on the stage still scrolls the page. The flat floor never orbits.
    if (press.mode === "tap" && e.pointerType === "mouse" && s !== S.FLOOR) press.mode = "orbit";
    if (e.pointerType === "mouse") { e.preventDefault(); viewEl.setPointerCapture(e.pointerId); }
  });
  viewEl.addEventListener("pointermove", (e) => {
    const p = local(e);
    ptr.x = p.x; ptr.y = p.y; ptr.type = e.pointerType; ptr.in = true;
    if (press) {
      const dx = p.x - press.x, dy = p.y - press.y;
      if (!press.dragging && dx * dx + dy * dy > 36) press.dragging = press.mode !== "tap";
      if (press.dragging) {
        if (press.mode === "orbit") {
          orbit.ty = clamp(press.yaw0 + dx * 0.006, -0.75, 0.75);
          orbit.tp = clamp(press.pitch0 + dy * 0.004, -0.35, 0.35);
          orbit.last = nowS();
        } else if (press.mode === "entity") press.sim.drag(p.x, p.y);
        setCursor("grabbing");
      }
    }
    requestRender();
  });
  viewEl.addEventListener("pointerup", (e) => {
    if (!press) return;
    const pr = press;
    press = null;
    const p = local(e);
    const moved = (p.x - pr.x) ** 2 + (p.y - pr.y) ** 2 > 64;
    if (pr.mode === "entity") pr.sim.release(pr.dragging);
    if (!pr.dragging && !moved && pr.sim) {
      pr.sim.hover(p.x, p.y);
      if (pr.sim.click(p.x, p.y)) dbg("click handled by", NAMES[pr.sim.slot]);
    }
    orbit.last = nowS();
    requestRender();
  });
  viewEl.addEventListener("pointercancel", () => { if (press && press.mode === "entity") press.sim.release(); press = null; });
  viewEl.addEventListener("pointerleave", () => { ptr.in = false; requestRender(); });

  /* ========== Main loop ========== */
  let d = 0, target = 0, booted = false;
  let raf = 0, pending = false, frames = 0, last = performance.now();

  function frameUpdate(dt, now) {
    target = api.targetSlot(scrollY);
    if (!booted || REDUCED) { d = REDUCED ? Math.round(target) : target; booted = true; }
    else {
      d += (target - d) * (1 - Math.exp(-dt * 3.4));
      if (Math.abs(target - d) < 0.0005) d = target;
    }
    const s = Math.min(Math.floor(d), shapes.length - 2);
    if (s !== seg) setSeg(s);
    const prog = clamp(d - s, 0, 1);

    // Orbit drifts home after a short rest; reduced motion keeps wherever it was left.
    if (live) {
      if (!press && nowS() - orbit.last > 1.5) { orbit.ty = 0; orbit.tp = 0; }
      const k = 1 - Math.exp(-dt * 4);
      orbit.yaw += (orbit.ty - orbit.yaw) * k;
      orbit.pitch += (orbit.tp - orbit.pitch) * k;
    } else { orbit.yaw = orbit.ty; orbit.pitch = orbit.tp; }
    points.updateMatrixWorld();

    uniforms.uProgress.value = prog;
    uniforms.uTime.value = t;
    uniforms.uFitFrom.value = shapeXform(s, uniforms.uXFrom.value);
    uniforms.uFitTo.value = shapeXform(s + 1, uniforms.uXTo.value);

    if (d < 1.05 || d > S.SIM - 1.05) writeFloor(now);
    for (const sim of simList) {
      const off = Math.abs(d - sim.slot);
      if (off > 1.05) continue; // offscreen simulations pause
      sim.update(dt, off < 0.6);
      sim.write();
    }
    dataTex.needsUpdate = true;

    updateHover();
    placeLabels();
  }

  function render() { renderer.render(scene, camera); }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    t += dt;
    frames++;
    frameUpdate(dt, now);
    render();
  }

  // Reduced motion: no loop, one frame whenever something changes.
  function requestRender() {
    if (dead || !REDUCED || pending) return;
    pending = true;
    requestAnimationFrame((now) => { pending = false; frameUpdate(0, now); render(); });
  }

  let inView = false;
  function startLoop() {
    if (dead || REDUCED || raf || document.hidden || !inView) return;
    last = performance.now();
    raf = requestAnimationFrame(loop);
    console.info("[stage] loop running");
  }
  function stopLoop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
    console.info("[stage] loop paused (" + (dead ? "stopped" : document.hidden ? "tab hidden" : "offscreen") + "), " + frames + " frames so far");
  }
  function syncLoop() { if (inView && !document.hidden) startLoop(); else stopLoop(); }

  document.addEventListener("visibilitychange", syncLoop);
  new IntersectionObserver((entries) => {
    inView = entries[0].isIntersecting;
    syncLoop();
    requestRender();
  }, { rootMargin: "200px 0px" }).observe(api.section);
  api.scrollHooks.push(requestRender);
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); dead = true; stopLoop(); api.fail("WebGL context lost"); });

  new ResizeObserver(() => resize()).observe(viewEl);
  if (document.fonts) document.fonts.addEventListener("loadingdone", () => { api.measure(); requestRender(); });

  resize();
  setSeg(0);
  if (REDUCED) requestRender();
  else syncLoop();

  console.info(`[stage] booted: ${N} points, DPR ${dpr}, WebGL2 ok, reduced motion ${REDUCED}`);

  if (DEBUG) {
    window.__stage = {
      get d() { return d; }, get target() { return target; }, get t() { return t; }, get G() { return G; },
      pointer(x, y) { ptr.x = x; ptr.y = y; ptr.in = true; ptr.type = "mouse"; requestRender(); },
      project: ctx.project, sims, renderer, uniforms, orbit,
    };
  }
  root.classList.add("stage-live");
  api.setGridVars(null);
}


export async function startGL(a) {
  api = a;
  ({ FS, h, $, root, viewEl, REDUCED, COARSE, DEBUG } = a);
  COPY = a.T;
  STATES = COPY.states;
  TASK = COPY.tasks;
  if (DEBUG) dbg = (...x) => console.debug("[stage]", ...x);
  await start();
}
