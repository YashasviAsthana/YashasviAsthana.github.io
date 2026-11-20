/* The warehouse floor in the hero, and the live view in the Nimble section.
   Orders spawn on rack faces, the nearest free robot claims each one, and every
   job is planned with space-time A* against a shared reservation table, so no
   two robots ever occupy the same cell or swap through each other.

   Grid cells have a fixed CSS px size (24 to 34 px), so zooming the browser out
   makes the floor bigger. The fleet and the order rate scale with the floor,
   up to FLEET_CAP robots, and planning is capped per frame so a big floor stays
   smooth. Ported from the concept A mockup (dispatch.js).

   Two page variants share this file. Variant A has a live view in the Nimble
   section (#monitor), drawn here. Variant E (the default) has the framed stage
   instead (stage-story.js, stage-gl.js): there is no #monitor, so every live
   view path below is skipped, and the stage reads the same simulation through
   the FloorSim object initDispatch() returns (layout, robots and orders in
   floor cells, the painted name's alpha mask, tick(now), order placement),
   with "floor:change" fired on window when the layout or the name paint changes. */
import { CONTENT as C } from "../data/content";

const params = new URLSearchParams(location.search);
const DEBUG = params.has("debug");
const dbg = (...a) => { if (DEBUG) console.debug("[dispatch]", ...a); };
const $ = (s, root) => (root || document).querySelector(s);

const STEP = 0.36;          // seconds per grid step; robots move at most one cell per step
const PICK_STEPS = 3;       // steps spent at the rack face
const DROP_STEPS = 3;       // steps spent at the station
const PREWARM = 40;         // seconds simulated before the first frame, so the page opens mid-shift
const MAX_EXPANSIONS = 14000;
const SEED = 20211101;      // fixed seed: the same shift plays out on every load
const FLEET_CAP = 160;      // a zoomed-out floor stays lively, but never unbounded
const PLAN_BUDGET_MS = 4;   // live planning time per frame; the rest of the queue waits a frame
const PREWARM_SLICE_MS = 10; // the prewarm yields to the main thread this often
const MAX_DPR = 2;
const MAX_CANVAS_PX = 8.3e6; // about one 4K screen of backing pixels per canvas

const FLOOR = 0, RACK = 1, STATION = 2, ZONE = 3;
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];   // right, down, left, up

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rgba(color, a) {
  let c = (color || "").trim();
  if (c[0] === "#") {
    if (c.length === 4) c = "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    const n = parseInt(c.slice(1, 7), 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    return "rgba(" + p[0] + "," + p[1] + "," + p[2] + "," + a + ")";
  }
  return c;
}

function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
}

export function initDispatch() {
  const hero = $(".hero");
  const canvas = $("#floor");
  const panel = $("#panel");
  const telem = $("#telemetry");
  const monitor = $("#monitor");
  const monitorFig = $("#monitor-fig");
  // Variant A has the live view; variant E has the stage, which brings its own canvas.
  const LIVE = !!(monitor && monitorFig);
  if (!hero || !canvas || !panel || !telem) {
    console.info("[dispatch] hero missing, simulation not started");
    return null;
  }
  const ctx = canvas.getContext("2d");
  const mctx = LIVE ? monitor.getContext("2d") : null;
  const staticCanvas = document.createElement("canvas");
  const sctx = staticCanvas.getContext("2d");
  // The page always animates, whatever the OS motion preference says.
  const reduced = false;

  // Small DOM enhancements the static HTML leaves to the script.
  if (matchMedia("(pointer: coarse)").matches) {
    document.querySelectorAll("[data-hint]").forEach((n) => { n.textContent = C.hero.hintTouch; });
  }
  // Each system name becomes a button that points the live view at it.
  document.querySelectorAll(".sys [data-name]").forEach((n) => {
    const b = h("button", { type: "button", "aria-pressed": "false", "aria-controls": "monitor-fig", text: n.textContent.trim() });
    n.replaceChildren(b);
  });

  let dpr = 1;
  let L = null;     // layout
  let S = null;     // simulation state
  let col = {};     // colors and fonts read from CSS variables
  let raf = 0, lastNow = 0, running = false;
  let hover = null;
  let nameImg = null;     // the painted name, kept for the stage to sample
  let stageOn = false;    // set when the Nimble stage (variant E) attaches
  let planDeadline = Infinity;
  let bootGen = 0;
  const frameMs = [];

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const get = (n) => cs.getPropertyValue(n).trim();
    col = {
      bg: get("--bg"), surface: get("--surface"), surface2: get("--surface-2"),
      ink: get("--ink"), muted: get("--muted"), line: get("--line"),
      accent: get("--accent"), accent2: get("--accent-2"),
      dark: (get("--scheme") || "dark") !== "light",
      display: get("--font-display") || "sans-serif",
      mono: get("--font-mono") || "monospace",
      weight: get("--display-weight") || "800",
    };
  }

  /* ===== Layout ===== */

  function buildLayout() {
    const hr = hero.getBoundingClientRect();
    const W = Math.max(1, Math.round(hr.width)), H = Math.max(1, Math.round(hr.height));
    const narrow = W < 720;
    const cell = narrow ? clamp(Math.round(W / 18), 18, 24) : clamp(Math.round(W / 46), 24, 34);
    const cols = Math.floor(W / cell), rows = Math.floor(H / cell);
    const ox = Math.floor((W - cols * cell) / 2), oy = Math.floor((H - rows * cell) / 2);
    const N = cols * rows;
    const type = new Uint8Array(N);
    const at = (c, r) => r * cols + c;
    const inb = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows;

    // Keep-out zones: the text panel and the telemetry booth, snapped to the grid
    // and to the canvas edge when they sit close to it.
    const zones = [];
    function zoneFor(node, kind) {
      const b = node.getBoundingClientRect();
      if (!b.width || !b.height) return null;
      const m = cell * (kind === "panel" ? 0.4 : 0.1);
      let c0 = Math.floor((b.left - hr.left - ox - m) / cell);
      let c1 = Math.floor((b.right - hr.left - ox + m) / cell);
      let r0 = Math.floor((b.top - hr.top - oy - m) / cell);
      let r1 = Math.floor((b.bottom - hr.top - oy + m) / cell);
      if (c0 <= 1) c0 = 0;
      if (r0 <= 1) r0 = 0;
      if (c1 >= cols - 3) c1 = cols - 1;
      if (r1 >= rows - 4) r1 = rows - 1;
      c0 = clamp(c0, 0, cols - 1); c1 = clamp(c1, 0, cols - 1);
      r0 = clamp(r0, 0, rows - 1); r1 = clamp(r1, 0, rows - 1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) type[at(c, r)] = ZONE;
      const z = { kind, c0, c1, r0, r1 };
      zones.push(z);
      return z;
    }
    const pz = zoneFor(panel, "panel");
    const tz = zoneFor(telem, "booth");

    // Pick stations along the right edge, with a two-lane road in front of them.
    const stW = narrow ? 1 : 2;
    const laneC = cols - stW - 2;            // first lane column
    const rackMaxC = laneC - 2;              // racks stop here, leaving one aisle before the lane
    const stations = [];
    const stTop = tz ? tz.r1 + 2 : 1;
    const stBottom = (pz && pz.c1 >= laneC ? pz.r0 - 2 : rows - 2);
    for (let r = stTop; r + 1 <= stBottom; r += narrow ? 3 : 4) {
      let ok = true;
      for (let rr = r; rr <= r + 1; rr++) for (let c = cols - stW; c < cols; c++) if (type[at(c, rr)] !== FLOOR) ok = false;
      if (type[at(cols - stW - 1, r)] !== FLOOR) ok = false;
      if (!ok) continue;
      for (let rr = r; rr <= r + 1; rr++) for (let c = cols - stW; c < cols; c++) type[at(c, rr)] = STATION;
      stations.push({ i: stations.length, c0: cols - stW, r0: r, w: stW, h: 2, drop: at(cols - stW - 1, r), pending: 0, flash: -9 });
    }

    // Staging band: open floor right above the panel. The name is painted here
    // and idle robots park here, so every job crosses the stencil.
    const floorBottom = pz && pz.r0 > 4 ? pz.r0 - 1 : rows - 2;
    const bandH = narrow
      ? clamp(Math.round((floorBottom + 1) * 0.4), 5, 9)
      : clamp(Math.round(rows * 0.3), 6, 11);
    const bandR1 = floorBottom;
    let bandR0 = Math.max(1, bandR1 - bandH + 1);
    // Keep the stencil clear of the telemetry booth when there is room.
    if (tz && tz.r1 + 1 > bandR0 && bandR1 - tz.r1 >= 5) bandR0 = tz.r1 + 1;

    const nearZone = (c, r) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = c + dx, y = r + dy;
        if (inb(x, y) && (type[at(x, y)] === ZONE || type[at(x, y)] === STATION)) return true;
      }
      return false;
    };

    const bay = narrow ? 4 : 6;
    const aisles = [];
    function rackBlock(rTop, rBot, cL, cR, fromBottom) {
      if (cR - cL < 3 || rBot - rTop < 1) return;
      const pairs = [];
      if (fromBottom) for (let y = rBot; y - 1 >= rTop; y -= 3) pairs.push([y - 1, y]);
      else for (let y = rTop; y + 1 <= rBot; y += 3) pairs.push([y, y + 1]);
      pairs.sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < pairs.length - 1; i++) aisles.push({ r: pairs[i][1] + 1, c: Math.max(0, cL - 1) });
      for (const [ra, rb] of pairs) {
        for (let c = cL; c <= cR; c++) {
          if ((c - cL) % (bay + 1) === bay) continue;      // cross-aisle
          if (cR - c < 1 && (c - cL) % (bay + 1) === 0) continue;
          for (const r of [ra, rb]) if (type[at(c, r)] === FLOOR && !nearZone(c, r)) type[at(c, r)] = RACK;
        }
      }
    }
    rackBlock(1, bandR0 - 1, 1, rackMaxC, true);
    if (pz && pz.c1 < rackMaxC - 6) rackBlock(bandR1 + 1, rows - 2, pz.c1 + 2, rackMaxC, false);

    // Drivable cells: floor connected to the staging band.
    const walk = new Uint8Array(N);
    const seed = at(Math.min(rackMaxC, Math.floor(cols / 3)), Math.floor((bandR0 + bandR1) / 2));
    if (seed >= 0 && seed < N && type[seed] === FLOOR) {
      const q = [seed]; walk[seed] = 1;
      while (q.length) {
        const c = q.pop(), x = c % cols, y = (c / cols) | 0;
        for (let k = 0; k < 4; k++) {
          const nx = x + DX[k], ny = y + DY[k];
          if (!inb(nx, ny)) continue;
          const n = at(nx, ny);
          if (!walk[n] && type[n] === FLOOR) { walk[n] = 1; q.push(n); }
        }
      }
    }

    // Rack faces that can hold an order: a rack cell next to a drivable cell.
    const faces = [];
    for (let c = 0; c < N; c++) {
      if (type[c] !== RACK) continue;
      const x = c % cols, y = (c / cols) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k], ny = y + DY[k];
        if (inb(nx, ny) && walk[at(nx, ny)]) faces.push({ i: faces.length, rack: c, pick: at(nx, ny), dir: k });
      }
    }
    for (const st of stations) st.ok = !!walk[st.drop];

    // Parking spots in the band: every other cell on every other row, so parked
    // robots never wall anything off. A second tier fills in if the fleet is big.
    const parking = [], parking2 = [];
    for (let r = bandR0 + 1; r <= bandR1 - 1; r++) {
      for (let c = 1; c <= rackMaxC; c++) {
        const i = at(c, r);
        if (!walk[i] || c % 2 === 0) continue;
        ((r - bandR0) % 2 === 1 ? parking : parking2).push(i);
      }
    }

    let drivable = 0;
    for (let i = 0; i < N; i++) drivable += walk[i];

    const key = [W, H, cell, zones.map((z) => [z.c0, z.c1, z.r0, z.r1].join(",")).join(";")].join("|");
    return {
      W, H, narrow, cell, cols, rows, ox, oy, N, type, walk, zones, stations, faces, parking, parking2,
      aisles, drivable, key, laneC, rackMaxC,
      band: { r0: bandR0, r1: bandR1 },
    };
  }

  /* ===== Simulation state ===== */

  // Robots scale with drivable floor area: a zoomed-out floor gets a bigger
  // fleet, more orders and more planning per step, up to FLEET_CAP.
  function fleetSize() {
    return L.narrow
      ? clamp(Math.round(L.drivable / 11), 12, 36)
      : clamp(Math.round(L.drivable / 22), 24, FLEET_CAP);
  }

  function buildSim() {
    const rng = mulberry32(SEED);
    const s = {
      rng, time: 0, step: 0, robots: [], orders: [],
      res: new Map(), cellT: new Array(L.N),
      holdR: new Int32Array(L.N).fill(-1), holdFrom: new Int32Array(L.N),
      nextSpawn: 1, nextId: 1, assigned: 0, done: 0, waits: [], claims: [],
      faceBusy: new Set(), pickBusy: new Set(), parkTaken: new Set(), dist: new Map(),
      events: [], planMs: [], userOrders: 0, ready: false, backlog: false,
    };
    S = s;
    const spots = shuffle(L.parking.slice(), rng).concat(shuffle(L.parking2.slice(), rng));
    const fleet = Math.min(fleetSize(), spots.length);
    for (let i = 0; i < fleet; i++) {
      const c = spots[i];
      const r = { id: i, path: [c], t0: 0, park: c, tPark: 0, job: null, ang: (Math.floor(rng() * 4) * Math.PI) / 2, glow: 0 };
      s.robots.push(r);
      s.holdR[c] = i; s.holdFrom[c] = 0;
      s.parkTaken.add(c);
    }
    s.target = Math.round(fleet * 0.5);
    // At the default desktop size (about 30 robots) these match the mockup: one
    // order per spawn and four plans per step.
    s.spawnBatch = Math.max(1, Math.round(fleet / 30));
    s.dispatchLimit = Math.max(4, Math.ceil(fleet / 8));
    // Distance fields are cached per pick cell; cap the cache at a few MB.
    s.distMax = clamp(Math.floor(6e6 / (L.N * 2)), 64, 2000);
  }

  function shuffle(a, rng) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  const cellAt = (r, t) => r.path[clamp(t - r.t0, 0, r.path.length - 1)];
  const cx = (c) => L.ox + ((c % L.cols) + 0.5) * L.cell;
  const cy = (c) => L.oy + (((c / L.cols) | 0) + 0.5) * L.cell;
  const manhattan = (a, b) => Math.abs((a % L.cols) - (b % L.cols)) + Math.abs(((a / L.cols) | 0) - ((b / L.cols) | 0));

  /* ===== Reservation table ===== */

  function reserve(id, c, t) {
    S.res.set(t * L.N + c, id);
    (S.cellT[c] || (S.cellT[c] = new Set())).add(t);
  }
  function unreserve(id, c, t) {
    const k = t * L.N + c;
    if (S.res.get(k) === id) { S.res.delete(k); if (S.cellT[c]) S.cellT[c].delete(t); }
  }
  function blocked(id, c, t) {
    const o = S.res.get(t * L.N + c);
    if (o !== undefined && o !== id) return true;
    const hr = S.holdR[c];
    return hr !== -1 && hr !== id && t >= S.holdFrom[c];
  }
  // The goal must stay free for the whole stay; a stay of Infinity means parking.
  function goalFree(id, c, t, stay) {
    if (stay === Infinity) {
      const hr = S.holdR[c];
      if (hr !== -1 && hr !== id) return false;
      const ts = S.cellT[c];
      if (ts) for (const tt of ts) if (tt >= t && S.res.get(tt * L.N + c) !== id) return false;
      return true;
    }
    for (let k = 1; k <= stay; k++) if (blocked(id, c, t + k)) return false;
    return true;
  }
  function gcReservations() {
    const cut = S.step - 2;
    for (const k of S.res.keys()) {
      const t = Math.floor(k / L.N);
      if (t < cut) { S.res.delete(k); const c = k - t * L.N; if (S.cellT[c]) S.cellT[c].delete(t); }
    }
  }

  /* ===== Space-time A* ===== */

  function Heap() { this.a = []; }
  Heap.prototype.push = function (n) {
    const a = this.a; a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f < n.f || (a[p].f === n.f && a[p].g >= n.g)) break;
      a[i] = a[p]; i = p;
    }
    a[i] = n;
  };
  Heap.prototype.pop = function () {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, best = last;
        if (l < n && (a[l].f < best.f || (a[l].f === best.f && a[l].g > best.g))) { m = l; best = a[l]; }
        if (r < n && (a[r].f < best.f || (a[r].f === best.f && a[r].g > best.g))) { m = r; best = a[r]; }
        if (m === i) break;
        a[i] = a[m]; i = m;
      }
      a[i] = last;
    }
    return top;
  };

  function planLeg(id, start, t0, goal, stay) {
    const { N, cols, rows, walk } = L;
    const gx = goal % cols, gy = (goal / cols) | 0;
    const hfn = (c) => Math.abs((c % cols) - gx) + Math.abs(((c / cols) | 0) - gy);
    const maxT = t0 + cols + rows + 60;
    const open = new Heap();
    const seen = new Set();
    open.push({ c: start, t: t0, g: 0, f: hfn(start), p: null, d: -1 });
    seen.add(t0 * N + start);
    let exp = 0;
    while (open.a.length) {
      const n = open.pop();
      if (n.c === goal && goalFree(id, goal, n.t, stay)) {
        const out = [];
        for (let x = n; x; x = x.p) out.push(x.c);
        return out.reverse();
      }
      if (++exp > MAX_EXPANSIONS) break;
      if (n.t >= maxT) continue;
      const t2 = n.t + 1, x = n.c % cols, y = (n.c / cols) | 0;
      for (let k = 0; k < 5; k++) {
        let c2 = n.c;
        if (k < 4) {
          const nx = x + DX[k], ny = y + DY[k];
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          c2 = ny * cols + nx;
          if (!walk[c2]) continue;
        }
        const key = t2 * N + c2;
        if (seen.has(key) || blocked(id, c2, t2)) continue;
        if (c2 !== n.c) {
          // No swapping places with a robot coming the other way.
          const q = S.res.get(n.t * N + c2);
          if (q !== undefined && q !== id && S.res.get(t2 * N + n.c) === q) continue;
        }
        seen.add(key);
        const turn = k < 4 && n.d >= 0 && n.d !== k ? 0.2 : 0;
        const g = n.g + 1 + turn + (k === 4 ? 0.04 : 0);
        open.push({ c: c2, t: t2, g, f: g + hfn(c2), p: n, d: k < 4 ? k : n.d });
      }
    }
    return null;
  }

  /* ===== Jobs ===== */

  function distFrom(src) {
    let d = S.dist.get(src);
    if (d) return d;
    d = new Int16Array(L.N).fill(-1);
    d[src] = 0;
    const q = [src];
    for (let hd = 0; hd < q.length; hd++) {
      const c = q[hd], x = c % L.cols, y = (c / L.cols) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k], ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= L.cols || ny >= L.rows) continue;
        const n = ny * L.cols + nx;
        if (L.walk[n] && d[n] < 0) { d[n] = d[c] + 1; q.push(n); }
      }
    }
    if (S.dist.size >= S.distMax) S.dist.delete(S.dist.keys().next().value);
    S.dist.set(src, d);
    return d;
  }

  // Plan a whole job in one pass: to the rack face, pick, to a station, drop,
  // then to a free parking spot. Either everything is reserved or nothing is.
  function planJob(r, o) {
    const id = r.id, N = L.N;
    const now = S.step, t0 = now + 1;
    const start = cellAt(r, t0);

    // Lift this robot's own future reservations and parking hold.
    const removed = [];
    for (let t = t0 + 1; t < r.t0 + r.path.length; t++) {
      const c = r.path[t - r.t0];
      if (S.res.get(t * N + c) === id) { unreserve(id, c, t); removed.push(c, t); }
    }
    const hadT0 = S.res.get(t0 * N + start) === id;
    const oldHold = S.holdR[r.park] === id ? { c: r.park, from: S.holdFrom[r.park] } : null;
    if (oldHold) S.holdR[oldHold.c] = -1;

    const made = [];
    const cells = [start];
    let t = t0, here = start;
    const put = (c, tt) => { reserve(id, c, tt); made.push(c, tt); };
    put(start, t0);

    function leg(goal, stay) {
      const p = planLeg(id, here, t, goal, stay);
      if (!p) return -1;
      for (let i = 1; i < p.length; i++) { put(p[i], t + i); cells.push(p[i]); }
      const arrive = t + p.length - 1;
      if (stay !== Infinity) for (let k = 1; k <= stay; k++) { put(goal, arrive + k); cells.push(goal); }
      t = arrive + (stay === Infinity ? 0 : stay);
      here = goal;
      return arrive;
    }

    function rollback() {
      for (let i = 0; i < made.length; i += 2) unreserve(id, made[i], made[i + 1]);
      for (let i = 0; i < removed.length; i += 2) reserve(id, removed[i], removed[i + 1]);
      if (hadT0) reserve(id, start, t0);
      if (oldHold) { S.holdR[oldHold.c] = id; S.holdFrom[oldHold.c] = oldHold.from; }
      return false;
    }

    const tPick = leg(o.pick, PICK_STEPS);
    if (tPick < 0) return rollback();

    const stations = L.stations.filter((s) => s.ok)
      .map((s) => ({ s, score: manhattan(o.pick, s.drop) + s.pending * 6 }))
      .sort((a, b) => a.score - b.score);
    let st = null, tDrop = -1;
    for (const cand of stations.slice(0, 3)) {
      tDrop = leg(cand.s.drop, DROP_STEPS);
      if (tDrop >= 0) { st = cand.s; break; }
    }
    if (!st) return rollback();

    // Parking: a random free spot in the band, so robots keep crossing the name.
    const pool = L.parking.concat(L.parking2).filter((c) =>
      !S.parkTaken.has(c) || c === r.park);
    let park = -1, tPark = -1;
    for (let i = 0; i < 6 && pool.length; i++) {
      const c = pool.splice(Math.floor(S.rng() * pool.length), 1)[0];
      if (S.holdR[c] !== -1 && S.holdR[c] !== id) continue;
      tPark = leg(c, Infinity);
      if (tPark >= 0) { park = c; break; }
    }
    if (park < 0) return rollback();

    // Commit.
    const keep = [];
    for (let tt = now; tt <= t0; tt++) keep.push(cellAt(r, tt));
    r.path = keep.concat(cells.slice(1));
    r.t0 = now;
    S.parkTaken.delete(r.park);
    S.parkTaken.add(park);
    r.park = park;
    r.tPark = tPark;
    S.holdR[park] = id; S.holdFrom[park] = tPark;
    st.pending++;
    r.job = {
      order: o, station: st, face: o.face,
      tPick, tPickEnd: tPick + PICK_STEPS, tDrop, tDropEnd: tDrop + DROP_STEPS,
      arrived: false, picked: false, dropped: false,
    };
    o.robot = r.id;
    o.claimedAt = S.time;
    S.assigned++;
    S.claims.push({ r, o, t: S.time });
    logEvent("claim", cx(start), cy(start), "robot " + (id + 1) + " claims order " + o.id, o.claimDist);
    dbg("claim", { order: o.id, robot: id, etaSec: +((tPick - now) * STEP).toFixed(1), station: st.i, park });
    return true;
  }

  function freeFace(f) {
    return !S.faceBusy.has(f.i) && !S.pickBusy.has(f.pick);
  }

  function addOrder(face, user) {
    const o = { id: S.nextId++, face, pick: face.pick, born: S.step, bornTime: S.time, robot: null, user: !!user, retryAt: 0, claimDist: 0 };
    S.orders.push(o);
    S.faceBusy.add(face.i);
    S.pickBusy.add(face.pick);
    if (user) S.userOrders++;
    const p = tileXY(face);
    logEvent("order", p.x, p.y, "order " + o.id + (user ? " placed by you" : " created"));
    return o;
  }

  // Event stream for the live view: every state change is an event with a place on the floor.
  function logEvent(kind, x, y, text, value) {
    S.events.push({ kind, x, y, text, value: value || 0, t: S.time });
    if (S.events.length > 400) S.events.splice(0, S.events.length - 400);
  }

  function spawnRandom() {
    const fs = L.faces;
    if (!fs.length) return;
    for (let i = 0; i < 24; i++) {
      const f = fs[Math.floor(S.rng() * fs.length)];
      if (freeFace(f)) { addOrder(f, false); return; }
    }
  }

  // Claims queued orders for the nearest free robots. Stops at `limit` orders
  // or when the frame's planning budget runs out; the rest wait for the next
  // frame (S.backlog) so a big floor never stalls a frame.
  function dispatch(limit, only, ignoreBudget) {
    let n = 0;
    if (!only) S.backlog = false;
    const queue = (only ? [only] : S.orders.filter((o) => o.robot === null))
      .sort((a, b) => (b.user - a.user) || (a.born - b.born));
    for (const o of queue) {
      if (n >= limit) break;
      if (o.retryAt > S.step) continue;
      if (!ignoreBudget && performance.now() > planDeadline) { S.backlog = true; break; }
      const d = distFrom(o.pick);
      const t1 = S.step + 1;
      const cands = [];
      for (const r of S.robots) {
        if (r.job) continue;
        const dd = d[cellAt(r, t1)];
        if (dd >= 0) cands.push({ r, dd });
      }
      if (!cands.length) break;
      cands.sort((a, b) => a.dd - b.dd);
      n++;
      let ok = false;
      for (let i = 0; i < Math.min(3, cands.length) && !ok; i++) {
        o.claimDist = cands[i].dd;
        const t0 = performance.now();
        ok = planJob(cands[i].r, o);
        S.planMs.push(performance.now() - t0);
      }
      if (S.planMs.length > 300) S.planMs.splice(0, S.planMs.length - 300);
      if (!ok) { o.retryAt = S.step + 2; dbg("assign deferred", { order: o.id }); }
    }
  }

  function onStep(t) {
    for (const r of S.robots) {
      const j = r.job;
      if (!j) continue;
      if (!j.arrived && t >= j.tPick) {
        j.arrived = true;
        const wait = (j.tPick * STEP) - j.order.bornTime;
        S.waits.push(wait);
        if (S.waits.length > 80) S.waits.shift();
      }
      if (!j.picked && t >= j.tPickEnd) {
        j.picked = true;
        const o = j.order;
        S.orders.splice(S.orders.indexOf(o), 1);
        S.faceBusy.delete(o.face.i);
        S.pickBusy.delete(o.pick);
        const p = tileXY(o.face);
        logEvent("pick", p.x, p.y, "robot " + (r.id + 1) + " picks order " + o.id);
      }
      if (!j.dropped && t >= j.tDropEnd) {
        j.dropped = true;
        j.station.pending--;
        j.station.flash = S.time;
        S.done++;
        r.job = null;
        const st = j.station;
        logEvent("drop", L.ox + (st.c0 + st.w / 2) * L.cell, L.oy + (st.r0 + 1) * L.cell,
          "robot " + (r.id + 1) + " drops at station " + (st.i + 1));
      }
    }
    if (t % 40 === 0) gcReservations();
    if (t >= S.nextSpawn) {
      for (let k = 0; k < S.spawnBatch && S.orders.length < S.target; k++) spawnRandom();
      S.nextSpawn = t + 1 + Math.floor(S.rng() * 3);
    }
    dispatch(S.dispatchLimit);
  }

  function advance(dt) {
    S.time += dt;
    const target = Math.floor(S.time / STEP);
    while (S.step < target) { S.step++; onStep(S.step); }
  }

  /* ===== Static floor layer ===== */

  function paintName(rect) {
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.ceil(rect.w * dpr));
    cv.height = Math.max(1, Math.ceil(rect.h * dpr));
    const g = cv.getContext("2d");
    g.scale(dpr, dpr);
    const name = C.name.toUpperCase();
    const words = name.split(/\s+/);
    const font = (s) => col.weight + " " + s + "px " + col.display;
    const track = 0.05;
    const setFont = (s) => {
      g.font = font(s);
      if ("letterSpacing" in g) g.letterSpacing = (track * s).toFixed(2) + "px";
    };
    setFont(100);
    const mH = g.measureText("H");
    const cap = (mH.actualBoundingBoxAscent || 70) / 100;
    const options = [[name]];
    if (words.length > 1) options.push([words[0], words.slice(1).join(" ")]);
    let best = null;
    for (const lines of options) {
      setFont(100);
      const w100 = Math.max(...lines.map((t) => g.measureText(t).width));
      const gap = 0.3;
      const hUnits = lines.length * cap + (lines.length - 1) * cap * gap;
      const s = Math.min((rect.w * 0.97) / (w100 / 100), (rect.h * 0.8) / hUnits);
      if (!best || s > best.s * 1.04) best = { lines, s, gap };
    }
    const s = best.s;
    setFont(s);
    g.fillStyle = col.accent;
    g.textBaseline = "alphabetic";
    const capPx = cap * s;
    const total = best.lines.length * capPx + (best.lines.length - 1) * capPx * best.gap;
    let y = (rect.h - total) / 2 + capPx;
    const spans = [];
    for (const t of best.lines) {
      const m = g.measureText(t);
      const x = m.actualBoundingBoxLeft || 0;
      g.fillText(t, x, y);
      // Character positions for stencil bridges.
      let acc = x;
      for (const ch of t) {
        const w = g.measureText(ch).width;
        spans.push({ ch, x: acc, w, y });
        acc += w;
      }
      y += capPx * (1 + best.gap);
    }

    // Stencil bridges, worn paint and wheel wear.
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = "#000";
    const bw = Math.max(2, s * 0.035);
    for (const sp of spans) {
      if (!/[AOBDPQRHSV]/.test(sp.ch)) continue;
      const mid = sp.x + (sp.w - track * s) / 2;
      if (sp.ch === "H") g.fillRect(mid - bw / 2, sp.y - capPx * 0.62, bw, capPx * 0.24);
      else if (sp.ch === "A" || sp.ch === "V") g.fillRect(mid - bw / 2, sp.y - capPx * (sp.ch === "A" ? 1.05 : 0.22), bw, capPx * (sp.ch === "A" ? 0.36 : 0.3));
      else if (sp.ch === "S") { g.fillRect(mid - bw / 2, sp.y - capPx * 1.05, bw, capPx * 0.2); g.fillRect(mid - bw / 2, sp.y - capPx * 0.16, bw, capPx * 0.2); }
      else g.fillRect(mid - bw / 2, sp.y - capPx * 1.05, bw, capPx * 0.22);
    }
    const rng = mulberry32(99);
    const area = rect.w * rect.h;
    for (let i = 0; i < area / 180; i++) {
      g.globalAlpha = 0.25 + rng() * 0.7;
      const r = 0.5 + rng() * 1.6;
      g.fillRect(rng() * rect.w, rng() * rect.h, r, r);
    }
    for (let i = 0; i < rect.h / 3; i++) {
      g.globalAlpha = 0.06 + rng() * 0.2;
      g.fillRect(rng() * rect.w - 40, rng() * rect.h, 40 + rng() * rect.w * 0.35, 0.8 + rng() * 2.4);
    }
    for (let i = 0; i < rect.w / 40; i++) {
      g.globalAlpha = 0.05 + rng() * 0.14;
      g.fillRect(rng() * rect.w, rng() * rect.h - 30, 0.8 + rng() * 2, 30 + rng() * rect.h * 0.5);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    return cv;
  }

  function hatch(g, x, y, w, hh, color, period) {
    g.save();
    g.beginPath(); g.rect(x, y, w, hh); g.clip();
    g.strokeStyle = color;
    g.lineWidth = period * 0.5;
    g.beginPath();
    for (let d = -hh; d < w + hh; d += period) { g.moveTo(x + d, y + hh); g.lineTo(x + d + hh, y); }
    g.stroke();
    g.restore();
  }

  function paintStatic() {
    if (!L) return;
    const { W, H, cell, cols, rows, ox, oy, type } = L;
    staticCanvas.width = Math.round(W * dpr);
    staticCanvas.height = Math.round(H * dpr);
    const g = sctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = col.bg;
    g.fillRect(0, 0, W, H);

    // Name paint on the staging band, under everything else.
    const headline = $(".headline");
    const hl = headline ? headline.getBoundingClientRect().left - hero.getBoundingClientRect().left : cell;
    const bx = clamp(Math.round(hl), cell * 0.5, W * 0.25);
    const rect = {
      x: bx,
      y: oy + L.band.r0 * cell,
      w: ox + L.laneC * cell - bx - cell * 0.5,
      h: (L.band.r1 - L.band.r0 + 1) * cell,
    };
    const booth = L.zones.find((z) => z.kind === "booth");
    if (booth && booth.r1 >= L.band.r0) rect.w = Math.min(rect.w, ox + booth.c0 * cell - bx - cell * 0.5);
    if (rect.w > 40 && rect.h > 20) {
      const img = paintName(rect);
      g.globalAlpha = col.dark ? 0.22 : 0.16;
      g.drawImage(img, rect.x, rect.y, rect.w, rect.h);
      g.globalAlpha = 1;
      nameImg = { cv: img, rect, alpha: null };
    } else nameImg = null;

    // Floor joints.
    const o = dpr === 1 ? 0.5 : 0;
    g.strokeStyle = rgba(col.line, col.dark ? 0.75 : 0.9);
    g.lineWidth = 1;
    g.beginPath();
    for (let c = 0; c <= cols; c++) { const x = ox + c * cell + o; g.moveTo(x, 0); g.lineTo(x, H); }
    for (let r = 0; r <= rows; r++) { const y = oy + r * cell + o; g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();

    // Racks: merge each row into runs; pairs read as back-to-back shelving.
    for (let r = 0; r < rows; r++) {
      let c = 0;
      while (c < cols) {
        if (type[r * cols + c] !== RACK) { c++; continue; }
        let e = c;
        while (e + 1 < cols && type[r * cols + e + 1] === RACK) e++;
        const above = r > 0 && type[(r - 1) * cols + c] === RACK;
        const below = r < rows - 1 && type[(r + 1) * cols + c] === RACK;
        const x = ox + c * cell + 2, w = (e - c + 1) * cell - 4;
        const y = oy + r * cell + (above ? 1 : 3), hh = cell - (above ? 1 : 3) - (below ? 1 : 3);
        g.fillStyle = col.surface2;
        g.fillRect(x, y, w, hh);
        g.strokeStyle = rgba(col.dark ? col.line : col.muted, col.dark ? 1 : 0.32);
        g.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
        g.strokeStyle = rgba(col.dark ? col.bg : col.muted, col.dark ? 0.45 : 0.18);
        g.beginPath();
        for (let k = c + 1; k <= e; k++) { const xx = ox + k * cell + o; g.moveTo(xx, y + 3); g.lineTo(xx, y + hh - 3); }
        g.stroke();
        c = e + 1;
      }
    }

    // Aisle codes, painted where an aisle opens onto the perimeter road.
    g.font = "500 " + Math.max(9, Math.round(cell * 0.32)) + "px " + col.mono;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = rgba(col.muted, 0.85);
    L.aisles.forEach((a, i) => {
      g.fillText(String.fromCharCode(65 + (i % 26)), ox + (a.c + 0.5) * cell, oy + (a.r + 0.5) * cell + 0.5);
    });

    // Stations.
    for (const st of L.stations) {
      const x = ox + st.c0 * cell + 3, y = oy + st.r0 * cell + 3;
      const w = st.w * cell - 3, hh = st.h * cell - 6;
      g.fillStyle = rgba(col.accent2, col.dark ? 0.16 : 0.12);
      g.fillRect(x, y, w, hh);
      g.strokeStyle = rgba(col.accent2, 0.9);
      g.lineWidth = 1.5;
      g.strokeRect(x + 0.75, y + 0.75, w - 1.5, hh - 1.5);
      g.fillStyle = col.accent2;
      g.fillRect(x, y + cell * 0.18, 3, cell * 0.64);
      g.fillStyle = rgba(col.accent2, 0.95);
      g.font = "500 " + Math.max(9, Math.round(cell * 0.3)) + "px " + col.mono;
      g.fillText(String(st.i + 1), x + w / 2 + 1, y + hh - cell * 0.42);
      g.lineWidth = 1;
    }

    // Keep-out zones.
    for (const z of L.zones) {
      let x0 = ox + z.c0 * cell, y0 = oy + z.r0 * cell, x1 = ox + (z.c1 + 1) * cell, y1 = oy + (z.r1 + 1) * cell;
      const L0 = z.c0 === 0, T0 = z.r0 === 0, R0 = z.c1 === cols - 1, B0 = z.r1 === rows - 1;
      if (L0) x0 = 0;
      if (T0) y0 = 0;
      if (R0) x1 = W;
      if (B0) y1 = H;
      g.fillStyle = col.bg;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      if (z.kind === "panel") {
        const hw = Math.max(6, Math.round(cell * 0.24));
        const color = rgba(col.accent, col.dark ? 0.5 : 0.42);
        const period = hw * 1.5;
        if (!T0) hatch(g, x0, y0, x1 - x0, hw, color, period);
        if (!R0) hatch(g, x1 - hw, y0, hw, y1 - y0, color, period);
        if (!L0) hatch(g, x0, y0, hw, y1 - y0, color, period);
        if (!B0) hatch(g, x0, y1 - hw, x1 - x0, hw, color, period);
      } else {
        g.strokeStyle = rgba(col.line, 1);
        g.lineWidth = 1;
        g.beginPath();
        if (!L0) { g.moveTo(x0 + 0.5, y0); g.lineTo(x0 + 0.5, y1); }
        if (!B0) { g.moveTo(x0, y1 - 0.5); g.lineTo(x1, y1 - 0.5); }
        if (!T0) { g.moveTo(x0, y0 + 0.5); g.lineTo(x1, y0 + 0.5); }
        if (!R0) { g.moveTo(x1 - 0.5, y0); g.lineTo(x1 - 0.5, y1); }
        g.stroke();
      }
    }
  }

  /* ===== Dynamic layer ===== */

  const easeIn = (f) => 2 * f * f - f * f * f;
  const easeOut = (f) => f + f * f - f * f * f;
  const smooth = (f) => f * f * (3 - 2 * f);

  function robotPose(r, s) {
    const k = Math.floor(s), f = s - k;
    const a = cellAt(r, k), b = cellAt(r, k + 1);
    if (a === b) return { x: cx(a), y: cy(a), moving: false, dir: -1 };
    const prev = cellAt(r, k - 1), next = cellAt(r, k + 2);
    const startStop = prev === a, endStop = next === b;
    const e = startStop && endStop ? smooth(f) : startStop ? easeIn(f) : endStop ? easeOut(f) : f;
    const x = cx(a) + (cx(b) - cx(a)) * e, y = cy(a) + (cy(b) - cy(a)) * e;
    return { x, y, moving: true, ang: Math.atan2(cy(b) - cy(a), cx(b) - cx(a)) };
  }

  function roundRect(g, x, y, w, hh, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + hh, r);
    g.arcTo(x + w, y + hh, x, y + hh, r);
    g.arcTo(x, y + hh, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function tileXY(face) {
    const k = face.dir, off = L.cell * 0.2;
    return { x: cx(face.rack) + DX[k] * off, y: cy(face.rack) + DY[k] * off };
  }

  function legCells(r, k, until) {
    const out = [];
    let last = -1;
    for (let t = k + 1; t <= until; t++) {
      const c = cellAt(r, t);
      if (c !== last) { out.push(c); last = c; }
    }
    return out;
  }

  // Poses and headings are computed once per frame and shared by the hero and the live view.
  function updatePoses(dt) {
    const s = S.time / STEP;
    const turn = dt ? Math.min(1, dt * 12) : 1;
    for (const r of S.robots) {
      const pose = robotPose(r, s);
      const j = r.job;
      let target = r.ang;
      if (pose.moving) target = pose.ang;
      else if (j && s >= j.tPick && s < j.tPickEnd) target = Math.atan2(-DY[j.face.dir], -DX[j.face.dir]);
      else if (j && s >= j.tDrop) target = 0;
      let d = target - r.ang;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      r.ang += d * turn;
      r.pose = pose;
    }
  }

  function drawRoutes(g, s, showAll) {
    const k = Math.floor(s);
    g.lineJoin = "round";
    g.lineCap = "round";
    for (const r of S.robots) {
      const j = r.job;
      if (!j) continue;
      const toPick = !j.arrived;
      if (!toPick && (!j.picked || k >= j.tDrop)) continue;
      const cs = legCells(r, k, toPick ? j.tPick : j.tDrop);
      if (!cs.length) continue;
      g.strokeStyle = toPick ? rgba(col.accent2, showAll ? 0.55 : 0.34) : rgba(col.accent, showAll ? 0.5 : 0.3);
      g.lineWidth = showAll ? 2 : 1.5;
      g.setLineDash(toPick ? [2, 5] : []);
      g.beginPath();
      g.moveTo(r.pose.x, r.pose.y);
      for (const c of cs) g.lineTo(cx(c), cy(c));
      g.stroke();
      g.setLineDash([]);
    }
  }

  function drawOrders(g, s, time) {
    const ts = L.cell * 0.34;
    for (const o of S.orders) {
      const p = tileXY(o.face);
      let size = ts, alpha = 1, x = p.x, y = p.y;
      const r = o.robot !== null ? S.robots[o.robot] : null;
      const j = r && r.job && r.job.order === o ? r.job : null;
      if (j && s >= j.tPick) {
        const q = clamp((s - j.tPick) / PICK_STEPS, 0, 1);
        x = p.x + (r.pose.x - p.x) * smooth(q);
        y = p.y + (r.pose.y - p.y) * smooth(q);
        size = ts * (1 - 0.35 * q);
      } else if (!j) {
        alpha = reduced ? 1 : 0.72 + 0.28 * Math.sin(time * 4.2 + o.id);
      }
      const age = time - o.bornTime;
      if (!reduced && age < 1.4) {
        const q = age / 1.4;
        g.strokeStyle = rgba(col.accent, 0.7 * (1 - q));
        g.lineWidth = 1.5;
        const rr = ts * (0.8 + q * (o.user ? 2.6 : 1.6));
        g.strokeRect(p.x - rr / 2, p.y - rr / 2, rr, rr);
      }
      if (!j && !reduced) {
        const q = (time * 0.9 + o.id * 0.37) % 1;
        g.strokeStyle = rgba(col.accent, 0.35 * (1 - q));
        g.lineWidth = 1;
        const rr = ts * (1.1 + q * 0.9);
        g.strokeRect(p.x - rr / 2, p.y - rr / 2, rr, rr);
      }
      if (j && s < j.tPick) {
        // Claimed: a teal frame that matches the route coming to get it.
        g.strokeStyle = rgba(col.accent2, 0.85);
        g.lineWidth = 1.25;
        const rr = ts * 1.55;
        g.strokeRect(p.x - rr / 2, p.y - rr / 2, rr, rr);
      }
      g.fillStyle = rgba(col.accent, alpha);
      roundRect(g, x - size / 2, y - size / 2, size, size, Math.max(1.5, size * 0.18));
      g.fill();
    }
  }

  function drawClaims(g, s, time, showAll) {
    for (let i = S.claims.length - 1; i >= 0; i--) {
      const c = S.claims[i];
      const age = time - c.t;
      if (age > 1.1) { S.claims.splice(i, 1); continue; }
      if (reduced && !showAll) continue;
      const p = tileXY(c.o.face);
      g.strokeStyle = rgba(col.accent2, 0.6 * (1 - age / 1.1));
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(c.r.pose.x, c.r.pose.y); g.lineTo(p.x, p.y); g.stroke();
    }
  }

  function drawRobot(g, r, s) {
    const cell = L.cell, size = cell * 0.62, rad = Math.max(2, size * 0.24);
    const pose = r.pose, j = r.job;
    let glow = 0;
    if (j) {
      if (s >= j.tPick && s < j.tPickEnd) glow = (s - j.tPick) / PICK_STEPS;
      else if (s >= j.tPickEnd && s < j.tDrop) glow = 1;
      else if (s >= j.tDrop) glow = clamp(1 - (s - j.tDrop) / DROP_STEPS, 0, 1);
    }
    const idle = !j && !pose.moving;
    g.save();
    g.translate(pose.x, pose.y);
    g.rotate(r.ang);
    if (glow > 0) {
      g.shadowColor = rgba(col.accent, 0.95 * glow);
      g.shadowBlur = cell * 0.7 * glow;
    }
    g.globalAlpha = idle ? 0.62 : 1;
    g.fillStyle = col.ink;
    roundRect(g, -size / 2, -size / 2, size, size, rad);
    g.fill();
    g.shadowBlur = 0;
    g.shadowColor = "transparent";
    const dropping = j && s >= j.tDrop;
    if (glow > 0.02 && !dropping) {
      const ts2 = size * 0.46;
      g.globalAlpha = glow;
      g.fillStyle = col.accent;
      roundRect(g, -ts2 / 2 - size * 0.06, -ts2 / 2, ts2, ts2, Math.max(1, ts2 * 0.2));
      g.fill();
    }
    if (j && s < j.tPick) {
      // En route to a pick: a teal status light.
      g.globalAlpha = 1;
      g.fillStyle = col.accent2;
      g.beginPath();
      g.arc(-size * 0.06, 0, size * 0.15, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = idle ? 0.62 : 1;
    g.fillStyle = col.bg;
    g.fillRect(size / 2 - size * 0.2, -size * 0.26, size * 0.09, size * 0.52);
    g.restore();

    if (dropping && s < j.tDropEnd) {
      // The tote slides off the robot into the station, mirroring the pick.
      const q = smooth(clamp((s - j.tDrop) / DROP_STEPS, 0, 1));
      const st = j.station;
      const sx = L.ox + (st.c0 + st.w / 2) * cell, sy = L.oy + (st.r0 + 0.5) * cell;
      const ts2 = size * 0.46 * (1 - 0.3 * q);
      g.globalAlpha = 1 - 0.5 * q;
      g.fillStyle = col.accent;
      roundRect(g, pose.x + (sx - pose.x) * q - ts2 / 2, pose.y + (sy - pose.y) * q - ts2 / 2, ts2, ts2, Math.max(1, ts2 * 0.2));
      g.fill();
    }
    g.globalAlpha = 1;
  }

  // The whole floor, in floor coordinates. The caller sets the transform.
  // `clip` (floor coordinates) skips robots outside the live view's crop.
  function drawScene(g, showAll, withHover, clip) {
    const cell = L.cell, s = S.time / STEP, time = S.time;
    g.drawImage(staticCanvas, 0, 0, L.W, L.H);
    for (const st of L.stations) {
      const age = time - st.flash;
      if (age < 0 || age > 0.9) continue;
      g.fillStyle = rgba(col.accent2, 0.45 * (1 - age / 0.9));
      g.fillRect(L.ox + st.c0 * cell + 3, L.oy + st.r0 * cell + 3, st.w * cell - 3, st.h * cell - 6);
    }
    drawRoutes(g, s, showAll);
    drawOrders(g, s, time);
    drawClaims(g, s, time, showAll);
    if (withHover && hover && freeFace(hover)) {
      const p = tileXY(hover), ts = cell * 0.34;
      g.strokeStyle = rgba(col.accent, 0.9);
      g.lineWidth = 1.5;
      g.setLineDash([3, 3]);
      g.strokeRect(p.x - ts * 0.7, p.y - ts * 0.7, ts * 1.4, ts * 1.4);
      g.setLineDash([]);
    }
    for (const r of S.robots) {
      if (clip && (r.pose.x < clip.x0 || r.pose.y < clip.y0 || r.pose.x > clip.x1 || r.pose.y > clip.y1)) continue;
      drawRobot(g, r, s);
    }
  }

  function drawHero(showAll) {
    if (!L || !S || !S.ready) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScene(ctx, showAll, true, null);
  }

  // Before the prewarm finishes, show the bare floor so the hero is never blank.
  function drawStaticOnly() {
    if (!L) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(staticCanvas, 0, 0, L.W, L.H);
  }

  /* ===== Live view: the Nimble section's window onto the floor ===== */

  let view = null;

  // A close-up crop of the floor, anchored on the stations so every system has something to show.
  function computeView(w, hh) {
    const pz = L.zones.find((z) => z.kind === "panel");
    let r0 = 0, r1 = L.rows - 1;
    if (pz && pz.c0 === 0 && pz.c1 === L.cols - 1 && pz.r0 > 4) r1 = pz.r0 - 1;
    const target = L.narrow ? 19 : 27;
    let cw = clamp(Math.round(w / target), 8, L.cols);
    let k = w / (cw * L.cell);
    let ch = hh / (L.cell * k);
    if (ch > r1 - r0 + 1) { ch = r1 - r0 + 1; k = hh / (ch * L.cell); cw = w / (L.cell * k); }
    const x0 = L.ox + (L.cols - cw) * L.cell;
    const top = clamp((r0 + r1 + 1) / 2 - ch / 2, r0, r1 + 1 - ch);
    return { k, x0, y0: L.oy + top * L.cell, w, h: hh };
  }

  function sizeMonitor() {
    if (!L || !LIVE) return;
    const b = monitor.getBoundingClientRect();
    if (!b.width || !b.height) return;
    view = computeView(b.width, b.height);
    monitor.width = Math.round(b.width * dpr);
    monitor.height = Math.round(b.height * dpr);
  }

  const STATES = ["idle", "to park", "to pick", "picking", "carrying", "dropping"];
  function stateOf(r, s) {
    const j = r.job;
    if (!j) return s < r.tPark ? "to park" : "idle";
    if (s < j.tPick) return "to pick";
    if (s < j.tPickEnd) return "picking";
    if (s < j.tDrop) return "carrying";
    return "dropping";
  }
  function stateColor(st) {
    if (st === "to pick" || st === "picking") return col.accent2;
    if (st === "carrying" || st === "dropping") return col.accent;
    return col.muted;
  }

  function inView(x, y, m) {
    return x > view.x0 - m && y > view.y0 - m && x < view.x0 + view.w / view.k + m && y < view.y0 + view.h / view.k + m;
  }
  function veil(g, a) {
    g.fillStyle = rgba(col.bg, a);
    g.fillRect(view.x0 - 2, view.y0 - 2, view.w / view.k + 4, view.h / view.k + 4);
  }
  // A small labelled tag; px converts screen pixels to the current drawing units.
  function pill(g, text, x, y, color, px, placed) {
    g.font = "500 " + (9.5 * px).toFixed(2) + "px " + col.mono;
    const w = g.measureText(text).width + 10 * px, hh = 15 * px;
    const box = { x: x - w / 2, y: y - hh, w, h: hh };
    if (placed) {
      for (const q of placed) if (box.x < q.x + q.w && q.x < box.x + box.w && box.y < q.y + q.h && q.y < box.y + box.h) return false;
      placed.push(box);
    }
    g.fillStyle = rgba(col.bg, 0.94);
    roundRect(g, box.x, box.y, w, hh, 3 * px);
    g.fill();
    g.strokeStyle = color;
    g.lineWidth = px;
    g.stroke();
    g.fillStyle = col.ink;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, x, y - hh / 2 + 0.5 * px);
    return true;
  }
  function line(g, a, b) { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }

  const overlays = {
    // Robot state badges.
    state(g, s, px) {
      veil(g, 0.5);
      const size = L.cell * 0.62, placed = [];
      const list = S.robots.filter((r) => inView(r.pose.x, r.pose.y, L.cell))
        .map((r) => ({ r, st: stateOf(r, s) }))
        .sort((a, b) => (a.st === "idle") - (b.st === "idle"));
      for (const { r, st } of list) {
        drawRobot(g, r, s);
        g.strokeStyle = stateColor(st);
        g.lineWidth = 1.5 * px;
        roundRect(g, r.pose.x - size * 0.8, r.pose.y - size * 0.8, size * 1.6, size * 1.6, size * 0.32);
        g.stroke();
      }
      for (const { r, st } of list) pill(g, st, r.pose.x, r.pose.y - size * 0.92, stateColor(st), px, placed);
    },

    // The task queue: open orders by number, and each robot's remaining tasks as numbered stops.
    scheduling(g, s, px) {
      veil(g, 0.5);
      const k = Math.floor(s), placed = [];
      g.lineJoin = "round";
      for (const r of S.robots) {
        const j = r.job;
        if (!j) continue;
        const cs = legCells(r, k, j.tDrop);
        g.strokeStyle = rgba(col.ink, 0.3);
        g.lineWidth = 1.25 * px;
        g.setLineDash([3 * px, 4 * px]);
        g.beginPath();
        g.moveTo(r.pose.x, r.pose.y);
        for (const c of cs) g.lineTo(cx(c), cy(c));
        g.stroke();
        g.setLineDash([]);
      }
      drawOrders(g, s, S.time);
      for (const r of S.robots) if (inView(r.pose.x, r.pose.y, L.cell)) drawRobot(g, r, s);
      for (const r of S.robots) {
        const j = r.job;
        if (!j) continue;
        const stops = [];
        if (s < j.tPick) stops.push([1, j.order.pick, col.accent2]);
        if (s < j.tDrop) stops.push([2, j.station.drop, col.accent]);
        stops.push([3, r.park, col.muted]);
        for (const [n, c, color] of stops) {
          const x = cx(c), y = cy(c), rr = (n === 3 ? 6 : 7.5) * px;
          if (!inView(x, y, rr)) continue;
          g.fillStyle = rgba(col.bg, 0.94);
          g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
          g.strokeStyle = color; g.lineWidth = 1.25 * px; g.stroke();
          g.fillStyle = col.ink;
          g.font = "500 " + (9 * px).toFixed(2) + "px " + col.mono;
          g.textAlign = "center"; g.textBaseline = "middle";
          g.fillText(String(n), x, y + 0.5 * px);
        }
      }
      for (const o of S.orders) {
        const p = tileXY(o.face);
        if (!inView(p.x, p.y, 0)) continue;
        pill(g, String(o.id), p.x, p.y - L.cell * 0.32, o.robot === null ? col.accent : col.accent2, px, placed);
      }
    },

    // Assignment: the winning robot for each order, and the free robots a queued order is weighed against.
    assignment(g, s, px) {
      veil(g, 0.5);
      const free = S.robots.filter((r) => !r.job);
      g.lineCap = "round";
      for (const o of S.orders) {
        if (o.robot !== null) continue;
        const p = tileXY(o.face), d = distFrom(o.pick);
        const near = free.map((r) => ({ r, d: d[cellAt(r, S.step + 1)] })).filter((x) => x.d >= 0)
          .sort((a, b) => a.d - b.d).slice(0, 3);
        g.strokeStyle = rgba(col.muted, 0.95);
        g.lineWidth = 1 * px;
        g.setLineDash([4 * px, 4 * px]);
        for (const x of near) line(g, x.r.pose, p);
        g.setLineDash([]);
      }
      const won = [];
      for (const r of S.robots) {
        const j = r.job;
        if (!j || s >= j.tPick) continue;
        const p = tileXY(j.face);
        g.strokeStyle = col.accent2;
        g.lineWidth = 1.75 * px;
        line(g, r.pose, p);
        won.push({ r, p, eta: Math.max(0, (j.tPick - s) * STEP) });
      }
      drawOrders(g, s, S.time);
      for (const r of S.robots) if (inView(r.pose.x, r.pose.y, L.cell)) drawRobot(g, r, s);
      for (const c of S.claims) {
        const q = clamp((S.time - c.t) / 1.1, 0, 1);
        g.strokeStyle = rgba(col.accent2, 0.9 * (1 - q));
        g.lineWidth = 1.5 * px;
        g.beginPath(); g.arc(c.r.pose.x, c.r.pose.y, L.cell * (0.45 + q * 0.6), 0, Math.PI * 2); g.stroke();
      }
      const placed = [];
      for (const w of won) {
        if (!inView(w.p.x, w.p.y, 0) && !inView(w.r.pose.x, w.r.pose.y, 0)) continue;
        pill(g, w.eta.toFixed(1) + " s", (w.r.pose.x + w.p.x) / 2, (w.r.pose.y + w.p.y) / 2 + 7 * px, col.accent2, px, placed);
      }
    },

    // Event-driven: every change on the floor is an event; each one rings where it happened.
    rust(g, s, px) {
      const colors = { order: col.accent, claim: col.accent2, pick: col.accent, drop: col.accent2 };
      for (let i = S.events.length - 1; i >= 0; i--) {
        const e = S.events[i];
        const age = S.time - e.t;
        if (age > 1.2) break;
        if (age < 0) continue;
        const q = age / 1.2;
        g.strokeStyle = rgba(colors[e.kind] || col.ink, 0.9 * (1 - q));
        g.lineWidth = 1.5 * px;
        g.beginPath(); g.arc(e.x, e.y, (8 + 22 * q) * px, 0, Math.PI * 2); g.stroke();
      }
    },

    // The floor is a simulation: frame it, and mark the orders the visitor placed.
    simulation(g, s, px) {
      for (const o of S.orders) {
        if (!o.user) continue;
        const p = tileXY(o.face);
        g.strokeStyle = col.accent;
        g.lineWidth = 1.5 * px;
        g.beginPath(); g.arc(p.x, p.y, L.cell * 0.55, 0, Math.PI * 2); g.stroke();
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const m = 10;
      g.strokeStyle = rgba(col.accent2, 0.9);
      g.lineWidth = 1;
      g.setLineDash([6, 5]);
      g.strokeRect(m + 0.5, m + 0.5, view.w - 2 * m - 1, view.h - 2 * m - 1);
      g.setLineDash([]);
      g.textAlign = "left";
      const tag = (text, x, y) => {
        g.font = "500 10px " + col.mono;
        const w = g.measureText(text).width + 12;
        g.fillStyle = rgba(col.bg, 0.94);
        g.fillRect(x, y, w, 18);
        g.strokeStyle = rgba(col.accent2, 0.9);
        g.strokeRect(x + 0.5, y + 0.5, w - 1, 17);
        g.fillStyle = col.ink;
        g.textBaseline = "middle";
        g.fillText(text, x + 6, y + 9.5);
      };
      tag("simulated floor, seed " + SEED, m + 8, m + 8);
      tag("sim clock " + clock(S.time), m + 8, view.h - m - 26);
    },
  };

  let active = C.nimble.systems[0].id;

  function drawMonitor(showAll) {
    if (!view || !L || !S || !S.ready) return;
    const g = mctx, k = view.k * dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = col.bg;
    g.fillRect(0, 0, monitor.width, monitor.height);
    g.setTransform(k, 0, 0, k, -view.x0 * k, -view.y0 * k);
    const m = L.cell;
    drawScene(g, showAll, false, { x0: view.x0 - m, y0: view.y0 - m, x1: view.x0 + view.w / view.k + m, y1: view.y0 + view.h / view.k + m });
    const fn = overlays[active];
    if (fn) fn(g, S.time / STEP, 1 / view.k);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
  }

  /* ===== Readout under the live view ===== */

  const roTitle = $("[data-readout-title]"), roBody = $("[data-readout-body]");
  const TITLES = {
    state: "Every robot's state, live",
    scheduling: "Each order becomes three tasks: pick, drop, park",
    assignment: "Which robot takes which order",
    rust: "Planner timing and the event stream",
    simulation: "Everything on this floor is simulated",
  };

  function pct(arr, p) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
  }
  function clock(t) {
    const m = Math.floor(t / 60), sec = Math.floor(t % 60);
    return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
  }
  const ms = (v) => (v < 0.01 ? "under 0.01 ms" : v.toFixed(2) + " ms");
  const kv = (label, value) => h("p", { class: "ro-line" }, label + " ", h("b", { text: value }));

  const readouts = {
    state(s) {
      const counts = Object.fromEntries(STATES.map((x) => [x, 0]));
      for (const r of S.robots) counts[stateOf(r, s)]++;
      return [
        h("ul", { class: "chips", "aria-label": "Robots by state" }, STATES.map((x) =>
          h("li", { class: "chip st-" + x.replace(" ", "-") },
            h("span", { class: "chip-dot", "aria-hidden": "true" }), x + " ", h("b", { text: String(counts[x]) })))),
        h("p", { class: "ro-note", text: "Badges on the floor are each robot's current state; counts cover the whole fleet." }),
      ];
    },
    scheduling(s) {
      const rows = S.orders.slice().sort((a, b) => a.born - b.born).slice(0, 4).map((o) => {
        const r = o.robot !== null ? S.robots[o.robot] : null;
        const j = r && r.job && r.job.order === o ? r.job : null;
        let what;
        if (!j) what = h("span", { text: "queued for " + (S.time - o.bornTime).toFixed(1) + " s" });
        else {
          const st = j.station.i + 1;
          const now = s < j.tPick ? 0 : 1;
          const parts = ["pick", "drop at " + st, "park"];
          what = h("span", null, ...parts.map((t, i) => [i ? ", " : "", i === now ? h("b", { text: t }) : t]));
        }
        return h("li", null, h("span", { class: "q-id", text: "Order " + o.id }), what);
      });
      const queued = S.orders.filter((o) => o.robot === null).length;
      return [
        h("ul", { class: "qrows" }, rows),
        h("p", { class: "ro-note", text: S.orders.length + " open orders, " + queued + " waiting for a robot. Circled numbers on the floor are each robot's remaining tasks." }),
      ];
    },
    assignment() {
      const recent = S.events.filter((e) => e.kind === "claim" && S.time - e.t <= 60);
      const dist = pct(recent.map((e) => e.value), 0.5);
      const wait = pct(S.waits, 0.5);
      return [
        kv("Claims in the last minute", String(recent.length)),
        kv("Median path distance at claim", dist + " cells"),
        kv("Median wait for a robot", wait.toFixed(1) + " s"),
        h("p", { class: "ro-note", text: "Solid: the robot that took the order, with its arrival time. Dashed: the free robots a queued order is weighed against." }),
      ];
    },
    rust() {
      const recent = S.events.filter((e) => S.time - e.t <= 10).length;
      const log = S.events.slice(-4).reverse().map((e) =>
        h("li", null, h("span", { class: "q-id", text: clock(e.t) + "." + Math.floor((e.t % 1) * 10) }), e.text));
      return [
        kv("Plan per job, p50", ms(pct(S.planMs, 0.5))),
        kv("Plan per job, p95", ms(pct(S.planMs, 0.95))),
        kv("Events in the last 10 s", String(recent)),
        h("ul", { class: "qrows ro-log", "aria-label": "Latest events" }, log),
        h("p", { class: "ro-note", text: "Timings come from this page's JavaScript planner, measured live." }),
      ];
    },
    simulation() {
      return [
        kv("Sim clock", clock(S.time)),
        kv("Seed", String(SEED)),
        kv("Orders generated", S.nextId - 1 + ""),
        kv("Placed by you", String(S.userOrders)),
        h("p", { class: "ro-note", text: "Synthetic orders and mock robots, written from scratch for this site. Click this view or the floor above to add an order." }),
      ];
    },
  };

  let lastReadout = 0, shownTitle = "";
  function updateReadout(force) {
    if (!S || !S.ready || !roTitle || !roBody) return;
    const now = performance.now();
    if (!force && now - lastReadout < 400) return;
    lastReadout = now;
    const title = TITLES[active] || "";
    if (title !== shownTitle) { roTitle.textContent = title; shownTitle = title; }
    roBody.replaceChildren(...readouts[active](S.time / STEP));
  }

  /* ===== Telemetry ===== */

  const tFleet = $("[data-t=fleet]"), tAssigned = $("[data-t=assigned]"), tWait = $("[data-t=wait]");
  let lastTelem = -1;
  function updateTelemetry(force) {
    if (!S || !S.ready || (!force && S.step === lastTelem)) return;
    lastTelem = S.step;
    tFleet.textContent = String(S.robots.length);
    tAssigned.textContent = String(S.assigned);
    if (S.waits.length) tWait.textContent = pct(S.waits, 0.5).toFixed(1) + " s";
  }

  /* ===== Loop ===== */

  let heroVisible = true, monitorVisible = false;
  const wanted = () => !reduced && !!S && S.ready && !document.hidden && (heroVisible || monitorVisible);
  const why = () => (reduced ? "reduced motion" : !S || !S.ready ? "warming up" : document.hidden ? "tab hidden" : "offscreen");

  // Advances the simulation to a rAF timestamp. The hero loop calls it every
  // frame, and in variant E the stage calls it too (FloorSim.tick): whichever
  // comes second on the same timestamp is a no-op, so the sim moves once a frame.
  let lastStep = -1;
  function stepTo(now) {
    if (!S || !S.ready || now === lastStep) return false;
    lastStep = now;
    planDeadline = performance.now() + PLAN_BUDGET_MS;
    const dt = lastNow ? Math.min(0.05, (now - lastNow) / 1000) : 0.016;
    lastNow = now;
    advance(dt);
    // Orders left over when the budget ran out get planned with this frame's remainder.
    if (S.backlog && performance.now() < planDeadline) dispatch(S.dispatchLimit);
    updatePoses(dt);
    return true;
  }

  function frame(now) {
    raf = 0;
    if (!running) return;
    const t0 = performance.now();
    stepTo(now);
    if (heroVisible) drawHero(false);
    if (monitorVisible) { drawMonitor(false); updateReadout(false); }
    updateTelemetry(false);
    if (DEBUG) { frameMs.push(performance.now() - t0); if (frameMs.length > 240) frameMs.shift(); }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || !wanted()) return;
    running = true;
    lastNow = 0;
    raf = requestAnimationFrame(frame);
    console.info("[dispatch] running", { hero: heroVisible, liveView: monitorVisible, fleet: S.robots.length });
  }
  function stop(reason) {
    if (!running) return;
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    console.info("[dispatch] paused (" + (reason || why()) + ")");
  }
  function syncLoop() { if (wanted()) start(); else stop(); }

  function renderStill() {
    if (!S || !S.ready) return;
    updatePoses(0);
    drawHero(true);
    drawMonitor(true);
    updateTelemetry(true);
    updateReadout(true);
  }

  /* ===== Setup, resize, zoom and font changes ===== */

  function sizeCanvas() {
    dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    // Very large floors (a zoomed-out window on a big screen) get a lower
    // backing resolution rather than an unbounded canvas.
    const px = L.W * L.H * dpr * dpr;
    if (px > MAX_CANVAS_PX) dpr = Math.sqrt(MAX_CANVAS_PX / (L.W * L.H));
    canvas.width = Math.round(L.W * dpr);
    canvas.height = Math.round(L.H * dpr);
  }

  // Simulates PREWARM seconds before the first frame, in slices that yield to
  // the main thread, so a big floor never blocks the page while it loads.
  function boot(reason, prev) {
    const gen = ++bootGen;
    stop("rebuilding the floor");
    buildSim();
    const steps = Math.round(PREWARM / STEP);
    const t0 = performance.now();
    let i = 0, slices = 0;
    planDeadline = Infinity;
    const slice = () => {
      if (gen !== bootGen) return;
      slices++;
      const end = performance.now() + PREWARM_SLICE_MS;
      planDeadline = Infinity;
      while (i < steps && performance.now() < end) { advance(STEP); i++; }
      if (i < steps) { setTimeout(slice, 0); return; }
      S.ready = true;
      const info = "fleet " + S.robots.length + ", grid " + L.cols + "x" + L.rows + " at " + L.cell + "px (floor " +
        L.W + "x" + L.H + " css px), " + L.stations.length + " stations, " + L.faces.length + " rack faces, prewarm " +
        Math.round(performance.now() - t0) + " ms in " + slices + " slice" + (slices === 1 ? "" : "s");
      if (reason === "boot") console.info("[dispatch] scene booted: " + info);
      else console.info("[dispatch] rebuilt on " + reason + ": " + info + (prev ? " (was fleet " + prev.fleet + ", grid " + prev.grid + ")" : ""));
      hover = null;
      if (reduced) {
        renderStill();
        console.info("[dispatch] reduced motion: showing a still frame with every route drawn");
      } else {
        updatePoses(0); drawHero(false); drawMonitor(false); updateTelemetry(true); updateReadout(true);
      }
      if (stageOn) { checkMask(); notifyStage(reason === "boot" ? "boot" : "layout"); }
      syncLoop();
    };
    slice();
  }

  function relayout(force, reason) {
    readColors();
    const next = buildLayout();
    const rebuilt = force || !L || next.key !== L.key;
    const prev = L && S ? { fleet: S.robots.length, grid: L.cols + "x" + L.rows } : null;
    if (rebuilt) {
      L = next;
      sizeCanvas();
      dbg("layout", JSON.stringify({ zones: L.zones, band: L.band }));
    }
    paintStatic();
    sizeMonitor();
    if (rebuilt) {
      // Show the bare floor right away; robots appear when the prewarm is done.
      drawStaticOnly();
      boot(prev ? reason || "resize" : "boot", prev);
      return;
    }
    // Draw right away so a resized (and therefore cleared) canvas never shows blank.
    if (!S || !S.ready) drawStaticOnly();
    else if (reduced || !running) renderStill();
    else { updatePoses(0); drawHero(false); drawMonitor(false); updateTelemetry(true); updateReadout(true); }
    if (stageOn && S && S.ready && checkMask()) notifyStage("name paint");
  }

  let relayoutTimer = 0;
  function scheduleRelayout(delay, reason) {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => relayout(false, reason), delay == null ? 140 : delay);
  }

  function repaint() {
    readColors();
    paintStatic();
    if (!S || !S.ready) drawStaticOnly();
    else if (reduced || !running) renderStill();
    if (stageOn && S && S.ready && checkMask()) notifyStage("name paint");
  }

  // Variant E: the stage samples the painted name as points, so tell it when
  // the paint really changed (a new layout or a font that finished loading).
  let version = 0, maskSig = "";
  function notifyStage(reason) {
    version++;
    console.info("[dispatch] stage notified: " + reason + " (version " + version + ")");
    window.dispatchEvent(new CustomEvent("floor:change", { detail: { reason, version } }));
  }
  function checkMask() {
    if (!nameImg) return false;
    const { cv } = nameImg;
    let sig = cv.width + "x" + cv.height + "@" + nameImg.rect.x.toFixed(1) + "," + nameImg.rect.y.toFixed(1);
    try {
      const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      let sum = 0;
      for (let i = 3; i < d.length; i += 4 * 61) sum += d[i];
      sig += ":" + sum;
      nameImg.alpha = d;
    } catch (e) { nameImg.alpha = null; }
    if (sig === maskSig) return false;
    maskSig = sig;
    return true;
  }

  /* ===== Input ===== */

  function nearestFace(px, py) {
    let best = null, bd = Infinity;
    for (const f of L.faces) {
      if (!freeFace(f)) continue;
      const p = tileXY(f);
      const d = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  function placeOrder(face, from) {
    if (!S || !S.ready || !face || !freeFace(face)) return null;
    const o = addOrder(face, true);
    dispatch(1, o, true);
    const info = { order: o.id, claimedBy: o.robot === null ? "queued" : "robot " + (o.robot + 1) };
    if (from) info.from = from;
    console.info("[dispatch] order placed by visitor", info);
    if (reduced) renderStill();
    else updateReadout(true);
    return o;
  }

  function localPoint(e, el) {
    const b = el.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  canvas.addEventListener("pointermove", (e) => {
    if (!L || !S || !S.ready || e.pointerType === "touch") return;
    const p = localPoint(e, canvas);
    hover = nearestFace(p.x, p.y);
    if (reduced) renderStill();
  });
  canvas.addEventListener("pointerleave", () => { hover = null; if (reduced) renderStill(); });
  canvas.addEventListener("click", (e) => {
    if (!L || !S) return;
    const p = localPoint(e, canvas);
    placeOrder(nearestFace(p.x, p.y));
  });
  canvas.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (!L || !S) return;
    e.preventDefault();
    const free = L.faces.filter(freeFace);
    if (free.length) placeOrder(free[Math.floor(Math.random() * free.length)]);
  });
  // The live view is the same floor, so clicking it places an order too.
  if (LIVE) monitor.addEventListener("click", (e) => {
    if (!L || !S || !view) return;
    const p = localPoint(e, monitor);
    placeOrder(nearestFace(view.x0 + p.x / view.k, view.y0 + p.y / view.k));
  });

  /* ===== Systems list: hover, focus, tap or scroll picks what the live view shows ===== */

  const sysItems = Array.from(document.querySelectorAll(".sys"));
  let hoverId = null, focusId = null, tapId = null, scrollId = active;
  const narrowMq = matchMedia("(max-width: 959px)");

  function setActive() {
    const id = hoverId || focusId || tapId || scrollId;
    if (id === active) return;
    active = id;
    for (const li of sysItems) {
      const on = li.dataset.id === id;
      li.classList.toggle("is-active", on);
      const b = li.querySelector("button");
      if (b) b.setAttribute("aria-pressed", String(on));
    }
    const name = (C.nimble.systems.find((x) => x.id === id) || {}).name || "";
    monitor.setAttribute("aria-label", "Live view of the illustrative fleet simulation, showing: " + (TITLES[id] || name));
    dbg("live view", id);
    updateReadout(true);
    // Redraw now rather than on the next frame, so the view answers the pointer immediately.
    if (reduced || !running) renderStill();
    else drawMonitor(false);
  }

  for (const li of sysItems) {
    const id = li.dataset.id;
    li.addEventListener("pointerenter", (e) => { if (e.pointerType !== "touch") { hoverId = id; setActive(); } });
    li.addEventListener("pointerleave", () => { if (hoverId === id) { hoverId = null; setActive(); } });
    li.addEventListener("focusin", () => { focusId = id; setActive(); });
    li.addEventListener("focusout", () => { if (focusId === id) { focusId = null; setActive(); } });
    li.addEventListener("click", () => { tapId = id; setActive(); });
  }

  // Scrolling through the list walks the live view through each system, which also works on touch.
  let scrollQueued = false;
  function onScroll() {
    scrollQueued = false;
    const fig = monitorFig.getBoundingClientRect();
    const lineY = narrowMq.matches ? Math.min(innerHeight * 0.8, fig.bottom + (innerHeight - fig.bottom) * 0.3) : innerHeight * 0.45;
    let id = sysItems.length ? sysItems[0].dataset.id : active;
    for (const li of sysItems) if (li.getBoundingClientRect().top <= lineY) id = li.dataset.id;
    if (id !== scrollId) { scrollId = id; tapId = null; setActive(); }
  }
  if (LIVE) addEventListener("scroll", () => { if (!scrollQueued) { scrollQueued = true; requestAnimationFrame(onScroll); } }, { passive: true });
  if (sysItems.length) {
    sysItems[0].classList.add("is-active");
    const b = sysItems[0].querySelector("button");
    if (b) b.setAttribute("aria-pressed", "true");
  }

  /* ===== Visibility, resize, zoom, motion preference and fonts ===== */

  document.addEventListener("visibilitychange", syncLoop);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      heroVisible = entries[entries.length - 1].isIntersecting;
      syncLoop();
    }).observe(hero);
    if (LIVE) new IntersectionObserver((entries) => {
      monitorVisible = entries[entries.length - 1].isIntersecting;
      syncLoop();
      if (monitorVisible) { updateReadout(true); if (!running) renderStill(); }
    }).observe(monitor);
  } else {
    monitorVisible = LIVE;
  }

  // Zooming changes the hero's CSS size, which the ResizeObserver catches and
  // turns into a bigger or smaller floor.
  let seenSize = "";
  const ro = new ResizeObserver(() => {
    const b = hero.getBoundingClientRect(), p = panel.getBoundingClientRect();
    const m = LIVE ? monitor.getBoundingClientRect() : { width: 0, height: 0 };
    const sig = [b.width, b.height, p.width, p.height, m.width, m.height].map(Math.round).join("x");
    if (sig === seenSize) return;
    const first = !seenSize;
    seenSize = sig;
    // ResizeObserver runs before paint, so relayout here instead of debouncing.
    if (!first) relayout(false, "resize");
  });
  ro.observe(hero);
  ro.observe(panel);
  if (LIVE) ro.observe(monitor);

  // A zoom that leaves the CSS size alone (or a move to another screen) still
  // changes devicePixelRatio, which changes the backing store size.
  function watchDpr() {
    const mq = matchMedia("(resolution: " + (window.devicePixelRatio || 1) + "dppx)");
    mq.addEventListener("change", () => {
      console.info("[dispatch] device pixel ratio changed to " + window.devicePixelRatio);
      if (L) { sizeCanvas(); paintStatic(); sizeMonitor(); if (!S || !S.ready) drawStaticOnly(); else if (reduced || !running) renderStill(); }
      watchDpr();
    }, { once: true });
  }
  watchDpr();

  if (document.fonts) {
    document.fonts.addEventListener("loadingdone", () => { repaint(); scheduleRelayout(60, "font load"); });
    document.fonts.ready.then(() => { repaint(); });
  }

  // First boot. The webfonts set the panel's size, and the panel is a keep-out
  // zone, so if they are still loading, paint the bare floor now and start the
  // fleet once they settle (or after 1.5 s). That saves a second prewarm.
  function firstBoot() {
    if (!document.fonts || document.fonts.status === "loaded") { relayout(true, "boot"); return; }
    readColors();
    L = buildLayout();
    sizeCanvas();
    paintStatic();
    sizeMonitor();
    drawStaticOnly();
    console.info("[dispatch] floor painted, waiting for webfonts before the fleet boots");
    let done = false;
    const go = (why) => {
      if (done) return;
      done = true;
      if (S) return; // a resize or font relayout already booted the fleet
      dbg("first boot after", why);
      L = null;
      relayout(true, "boot");
    };
    document.fonts.ready.then(() => go("fonts ready"));
    setTimeout(() => go("font timeout"), 1500);
  }
  firstBoot();

  if (DEBUG) {
    // Review hooks: fast-forward and count vertex and swap conflicts, place an
    // order at a point, or read frame and planner timings.
    window.__dispatch = {
      check(seconds) {
        let vertex = 0, swap = 0, steps = 0;
        const end = S.time + seconds;
        planDeadline = Infinity;
        while (S.time < end) {
          advance(STEP);
          steps++;
          const t = S.step, seen = new Map();
          for (const r of S.robots) {
            const c = cellAt(r, t);
            if (seen.has(c)) vertex++;
            seen.set(c, r.id);
          }
          for (const a of S.robots) for (const b of S.robots) {
            if (a.id < b.id && cellAt(a, t) === cellAt(b, t + 1) && cellAt(b, t) === cellAt(a, t + 1) && cellAt(a, t) !== cellAt(a, t + 1)) swap++;
          }
        }
        return { steps, vertex, swap, assigned: S.assigned, done: S.done, open: S.orders.length, busy: S.robots.filter((r) => r.job).length, fleet: S.robots.length };
      },
      click(x, y) {
        const f = nearestFace(x, y);
        placeOrder(f);
        const o = S.orders[S.orders.length - 1];
        return { face: f && f.i, claimedBy: o ? o.robot : null };
      },
      stats() {
        return {
          ready: S.ready, running, fleet: S.robots.length, grid: L.cols + "x" + L.rows, cell: L.cell, dpr,
          drivable: L.drivable, target: S.target, spawnBatch: S.spawnBatch, dispatchLimit: S.dispatchLimit,
          open: S.orders.length, busy: S.robots.filter((r) => r.job).length, assigned: S.assigned, done: S.done,
          planP50: pct(S.planMs, 0.5), planP95: pct(S.planMs, 0.95), planMax: Math.max(0, ...S.planMs),
          frameP50: pct(frameMs, 0.5), frameP95: pct(frameMs, 0.95), frameMax: Math.max(0, ...frameMs), frames: frameMs.length,
        };
      },
    };
  }

  /* ===== The floor, shared with the Nimble stage ===== */

  // Everything the stage reads is in floor cells: x is the column, z is the row, both continuous.
  function robotVisuals() {
    const s = S.time / STEP;
    return S.robots.map((r) => {
      const j = r.job, pose = r.pose || robotPose(r, s);
      let glow = 0;
      if (j) {
        if (s >= j.tPick && s < j.tPickEnd) glow = (s - j.tPick) / PICK_STEPS;
        else if (s >= j.tPickEnd && s < j.tDrop) glow = 1;
        else if (s >= j.tDrop) glow = clamp(1 - (s - j.tDrop) / DROP_STEPS, 0, 1);
      }
      const dropping = !!j && s >= j.tDrop;
      return {
        x: (pose.x - L.ox) / L.cell, z: (pose.y - L.oy) / L.cell, ang: r.ang,
        tote: dropping ? 0 : glow, light: j && s < j.tPick ? 1 : 0, idle: !j && !pose.moving ? 1 : 0,
      };
    });
  }

  function orderVisuals() {
    const out = [], s = S.time / STEP, time = S.time, ts = 0.34;
    for (const o of S.orders) {
      const p = tileXY(o.face);
      let size = ts, alpha = 1, x = p.x, y = p.y;
      const r = o.robot !== null ? S.robots[o.robot] : null;
      const j = r && r.job && r.job.order === o ? r.job : null;
      if (j && s >= j.tPick && r.pose) {
        const q = clamp((s - j.tPick) / PICK_STEPS, 0, 1);
        x = p.x + (r.pose.x - p.x) * smooth(q);
        y = p.y + (r.pose.y - p.y) * smooth(q);
        size = ts * (1 - 0.35 * q);
      } else if (!j) {
        alpha = reduced ? 1 : 0.72 + 0.28 * Math.sin(time * 4.2 + o.id);
      }
      out.push({ id: o.id, x: (x - L.ox) / L.cell, z: (y - L.oy) / L.cell, size, alpha, claimed: j && s < j.tPick ? 1 : 0, user: o.user ? 1 : 0, age: time - o.bornTime });
    }
    // Totes sliding off a robot into its station, mirroring the pick.
    for (const r of S.robots) {
      const j = r.job;
      if (!j || s < j.tDrop || s >= j.tDropEnd || !r.pose) continue;
      const q = smooth(clamp((s - j.tDrop) / DROP_STEPS, 0, 1)), st = j.station;
      const sx = L.ox + (st.c0 + st.w / 2) * L.cell, sy = L.oy + (st.r0 + 0.5) * L.cell;
      out.push({ id: -1, x: (r.pose.x + (sx - r.pose.x) * q - L.ox) / L.cell, z: (r.pose.y + (sy - r.pose.y) * q - L.oy) / L.cell, size: 0.285 * (1 - 0.3 * q), alpha: 1 - 0.5 * q, claimed: 0, user: 0, age: 9 });
    }
    return out;
  }

  return {
    // The stage calls this once, before the first boot completes; only then are
    // floor:change events and the name mask maintained (variant A never pays for them).
    attachStage() {
      if (stageOn) return;
      stageOn = true;
      if (S && S.ready) checkMask();
      console.info("[dispatch] stage attached to the shared floor");
    },
    get version() { return version; },
    get reduced() { return reduced; },
    get ready() { return !!(L && S && S.ready); },
    layout() {
      if (!L) return null;
      return {
        W: L.W, H: L.H, cell: L.cell, cols: L.cols, rows: L.rows, ox: L.ox, oy: L.oy, narrow: L.narrow,
        type: L.type, zones: L.zones, stations: L.stations, band: L.band, laneC: L.laneC,
        kinds: { FLOOR, RACK, STATION, ZONE },
      };
    },
    heroRect() { return hero.getBoundingClientRect(); },
    // The painted name: a dpr-scaled canvas, its alpha bytes and its rect in hero px.
    nameMask() { return nameImg && nameImg.alpha ? { alpha: nameImg.alpha, w: nameImg.cv.width, h: nameImg.cv.height, rect: nameImg.rect } : null; },
    // Advance the shared simulation to this rAF timestamp (no-op if the hero already did this frame).
    tick(now) { if (!reduced) stepTo(now); },
    robots() { return S && S.ready ? robotVisuals() : []; },
    orders() { return S && S.ready ? orderVisuals() : []; },
    stations() {
      if (!S) return [];
      return L.stations.map((st) => ({ c0: st.c0, r0: st.r0, w: st.w, h: st.h, flash: clamp(1 - (S.time - st.flash) / 0.9, 0, 1) }));
    },
    stats() {
      if (!S) return null;
      return { clock: clock(S.time), seed: SEED, generated: S.nextId - 1, placed: S.userOrders, fleet: S.robots.length, open: S.orders.length };
    },
    // Place an order at the free rack face nearest to a point given in floor cells.
    placeAtCell(x, z) {
      if (!L || !S || !S.ready) return null;
      return placeOrder(nearestFace(L.ox + x * L.cell, L.oy + z * L.cell), "stage");
    },
    placeRandom() {
      if (!L || !S || !S.ready) return null;
      const free = L.faces.filter(freeFace);
      return free.length ? placeOrder(free[Math.floor(Math.random() * free.length)], "stage") : null;
    },
    // Still fallback for the stage: the 2D floor with every route drawn, at
    // `scale` stage px per hero px, offset so floor cell (0, 0) lands at (gx, gy)
    // stage px, on a canvas with k device px per CSS px.
    drawStill(g, gx, gy, scale, k) {
      if (!L || !S || !S.ready) return false;
      updatePoses(0);
      const m = k * scale;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, g.canvas.width, g.canvas.height);
      g.setTransform(m, 0, 0, m, k * (gx - scale * L.ox), k * (gy - scale * L.oy));
      drawScene(g, true, false, null);
      g.setTransform(1, 0, 0, 1, 0, 0);
      return true;
    },
  };
}
