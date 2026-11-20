/* The Nimble stage, part 1: the scroll story, the still floor and the loader.
   Ported from the A + D blend mockup (stage.js, part 1).

   One framed, sticky stage walks through the five Nimble systems as the reader
   scrolls. This module runs at page load and is small: it builds the stage's
   footer and jump buttons, turns the step names into buttons, tracks which
   scene the scroll position asks for, and works out the window onto the hero's
   floor. The WebGL stage itself (stage-gl.js, with Three.js) is only imported
   once the reader has scrolled and the section is near the viewport, so the
   first load never pays for it. Without WebGL2 the stage shows a still of the
   2D floor instead, and that still also stands in while the WebGL stage loads.

   Review hooks: ?debug (console.debug, window.__stage), ?at=<scene id> scrolls
   there on load, ?nogl forces the still floor. */
import { CONTENT } from "../data/content";

const params = new URLSearchParams(location.search);
const DEBUG = params.has("debug");
const dbg = (...a) => { if (DEBUG) console.debug("[stage]", ...a); };
const root = document.documentElement;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// The opening floor scene never shrinks the hero floor below this, so its
// points stay readable; past it, the window slides to keep the stations in view.
const MIN_SCALE = 0.4;
// How far below the fold the section may be when the WebGL stage starts loading.
const LOAD_MARGIN = "50% 0px 120% 0px";

export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "on") for (const ev in v) e.addEventListener(ev, v[ev]);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}

export function initStage(FS) {
  const section = $("#nimble");
  const stageEl = $("#stage");
  const viewEl = $("[data-stage-view]");
  const footEl = $("[data-stage-foot]");
  const labelEl = $("[data-stage-label]");
  const ticksEl = $("[data-stage-ticks]");
  const stillCv = $("#stage-still");
  if (!section || !stageEl || !viewEl || !footEl || !labelEl || !ticksEl || !stillCv) {
    console.info("[stage] Nimble stage markup missing, skipping");
    return;
  }
  // Ask the shared floor for name-mask updates and floor:change events.
  FS.attachStage();
  const T = CONTENT.stage;
  const SYS = CONTENT.nimble.systems;
  const SLOT_IDS = ["floor", ...SYS.map((s) => s.id)];
  const COARSE = matchMedia("(pointer: coarse)").matches;
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const desktopMq = matchMedia("(min-width: 960px)");
  const stepEls = $$(".step", section);
  let FALLBACK = false;

  /* ===== Footer control sets, jump buttons and step buttons ===== */

  const sets = SLOT_IDS.map((id, slot) => {
    const pair = T.hints[id];
    const hint = pair ? pair[COARSE ? 1 : 0] : "";
    const set = h("div", { class: "ctl-set", "data-set": String(slot), hidden: slot !== 0 },
      hint ? h("p", { class: "ctl-hint" }, h("span", { class: "ctl-tile", "aria-hidden": "true" }), hint) : null,
      h("div", { class: "ctl-row", "data-controls": id }));
    footEl.append(set);
    return set;
  });
  const ticks = SYS.map((s, i) => {
    const b = h("button", { class: "stage-tick", type: "button", "aria-label": s.name, title: s.name });
    b.addEventListener("click", () => goTo(i + 1));
    ticksEl.append(b);
    return b;
  });
  stepEls.forEach((li, i) => {
    const n = li.querySelector("[data-name]");
    if (!n) return;
    const b = h("button", { type: "button", "aria-pressed": "false", "aria-controls": "stage", text: n.textContent.trim() });
    b.addEventListener("click", () => goTo(i + 1));
    n.replaceChildren(b);
  });

  /* ===== Scroll story: which scene the scroll position asks for ===== */

  const absTop = (el) => el.getBoundingClientRect().top + scrollY;
  let handoffs = [], win = 1, vh = innerHeight;
  function measure() {
    vh = innerHeight;
    const desk = desktopMq.matches;
    const sh = stageEl.offsetHeight;
    // Where a step has to reach before the stage hands over to it.
    const lineY = desk ? vh * 0.52 : Math.min(vh * 0.86, sh + (vh - sh) * 0.42);
    win = vh * (desk ? 0.16 : 0.12);
    handoffs = stepEls.map((el) => absTop(el) - lineY);
  }
  function targetSlot(y) {
    let s = 0;
    for (const hd of handoffs) s += smooth(hd - win, hd + win, y);
    return s;
  }

  let activeSlot = -1;
  let gridG = null; // the last floor frame, for the stage's CSS grid
  const listeners = [];
  function setActive(slot) {
    if (slot === activeSlot) return;
    activeSlot = slot;
    stepEls.forEach((li, i) => {
      const on = i + 1 === slot;
      li.classList.toggle("is-active", on);
      const b = li.querySelector("button");
      if (b) b.setAttribute("aria-pressed", String(on));
    });
    ticks.forEach((b, i) => { if (i + 1 === slot) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current"); });
    // The still floor only ever shows the floor, so its label stays put.
    labelEl.textContent = slot === 0 || FALLBACK ? T.floorLabel : SYS[slot - 1].name;
    sets.forEach((s, i) => { s.hidden = FALLBACK ? i !== 0 : i !== slot; });
    viewEl.style.setProperty("--grid-a", slot === 0 ? "1" : slot === SLOT_IDS.length - 1 ? "0.4" : "0.55");
    setGridVars(null);
    console.info("[stage] scene: " + SLOT_IDS[slot]);
    listeners.forEach((fn) => fn(slot));
  }

  // Where to scroll so a slot is fully on stage, with its step's text level with the stage's top.
  function slotScrollY(slot) {
    measure();
    // On tall windows the first step can reach its handoff before the section
    // reaches the top, so land early enough for the floor scene to hold.
    if (slot <= 0) return Math.min(absTop(section), handoffs.length ? handoffs[0] - win * 1.1 : Infinity);
    const el = stepEls[slot - 1];
    const desk = desktopMq.matches;
    const sh = stageEl.offsetHeight;
    const top = desk ? (vh - sh) / 2 : sh + 8;
    return Math.max(handoffs[slot - 1] + win * 1.1, absTop(el) - Math.max(16, top));
  }
  function goTo(slot) {
    const y = slotScrollY(slot);
    console.info("[stage] jump to " + SLOT_IDS[slot]);
    window.scrollTo({ top: Math.max(0, y), behavior: REDUCED ? "auto" : "smooth" });
  }

  let scrollQueued = false;
  const scrollHooks = [];
  function onScroll() {
    scrollQueued = false;
    setActive(Math.round(targetSlot(scrollY)));
    scrollHooks.forEach((fn) => fn());
  }
  addEventListener("scroll", () => { if (!scrollQueued) { scrollQueued = true; requestAnimationFrame(onScroll); } }, { passive: true });
  addEventListener("resize", () => { measure(); onScroll(); });
  new ResizeObserver(() => { measure(); onScroll(); }).observe(section);
  measure();
  onScroll();

  /* ===== The window onto the hero's floor ===== */

  // The painted name's horizontal extent in floor columns, measured from its alpha mask.
  let nameSpanKey = "", nameSpan = null;
  function nameColumns(F) {
    const m = FS.nameMask();
    if (!m) return null;
    const key = FS.version + ":" + m.w + "x" + m.h;
    if (key === nameSpanKey) return nameSpan;
    let x0 = m.w, x1 = -1;
    for (let x = 0; x < m.w; x += 2) {
      for (let y = 0; y < m.h; y += 3) if (m.alpha[(y * m.w + x) * 4 + 3] > 70) { if (x < x0) x0 = x; x1 = x; break; }
    }
    nameSpanKey = key;
    nameSpan = x1 < 0 ? null : {
      c0: (m.rect.x + (x0 / m.w) * m.rect.w - F.ox) / F.cell,
      c1: (m.rect.x + (x1 / m.w) * m.rect.w - F.ox) / F.cell,
    };
    return nameSpan;
  }

  // The floor's geometry inside a stage view of cw x ch CSS px. G.cell is stage
  // px per floor cell; (gx, gy) is where floor cell (0, 0) lands.
  // Scene 0 shows the painted name and the pick stations together. When that
  // span fits at the hero's own cell size, the grid stays in phase with the
  // hero's (it only slides by whole cells); when it does not (most desktops),
  // the floor is scaled down to fit, never below MIN_SCALE, and past that the
  // window keeps the stations in view and lets the name run off the left.
  function floorFrame(cw, ch) {
    const F = FS.layout();
    if (!F || !FS.ready) return null;
    const hr = FS.heroRect(), vr = viewEl.getBoundingClientRect();
    const cell = F.cell;
    const pz = F.zones.find((z) => z.kind === "panel");
    let lastRow = F.rows - 1;
    if (pz && pz.c0 === 0 && pz.c1 === F.cols - 1 && pz.r0 > 4) lastRow = pz.r0 - 1;
    const bandMid = (F.band.r0 + F.band.r1 + 1) / 2;

    const span = nameColumns(F);
    const stEnd = F.stations.length ? Math.max(...F.stations.map((s) => s.c0 + s.w)) : F.cols;
    const need0 = span ? Math.max(0, Math.floor(span.c0) - 1) : 0;
    const need1 = Math.min(F.cols, stEnd);
    const needW = Math.max(1, need1 - need0);

    const scale = clamp(cw / (needW * cell + cell * 0.5), MIN_SCALE, 1);
    const cs = cell * scale;
    let gx;
    if (scale === 1) {
      // Start from the hero's own columns at this screen x, then slide by whole
      // cells (so the grid stays in phase with the hero's) to centre the span.
      gx = Math.round(hr.left + F.ox - vr.left);
      if (F.cols * cell > cw + cell) {
        const want = cw / 2 - ((need0 + need1) / 2) * cell;
        gx += Math.round((want - gx) / cell) * cell;
        while (gx > 0) gx -= cell;
        while (gx + F.cols * cell < cw) gx += cell;
      }
    } else {
      const fits = needW * cs <= cw;
      gx = fits ? cw / 2 - ((need0 + need1) / 2) * cs : cw - need1 * cs - cs * 0.25;
      gx = Math.round(gx);
    }

    const visRows = ch / cs;
    let gy;
    if (visRows >= lastRow + 1) gy = Math.round((ch - (lastRow + 1) * cs) / 2);
    else gy = -Math.round(clamp(bandMid - visRows * 0.48, 0, lastRow + 1 - visRows)) * cs;

    // An odd number of lattice sites per cell, so every cell has a centre site.
    // A scaled-down floor gets a slightly finer lattice so the name stays legible.
    let sub = scale === 1 ? Math.floor(cs / 3.6) : Math.round(cs / 3.1);
    if (sub % 2 === 0) sub -= 1;
    sub = clamp(sub, 3, 9);

    let subSim = Math.floor(cell / 3.6);
    if (subSim % 2 === 0) subSim -= 1;
    subSim = clamp(subSim, 3, 9);

    // The other scenes keep the blend's 1:1 grid: the hero's own columns at this
    // screen x, slid by whole cells to centre the painted name.
    let gx1 = Math.round(hr.left + F.ox - vr.left);
    if (span && F.cols * cell > cw + cell) {
      const want = cw / 2 - ((span.c0 + span.c1) / 2) * cell;
      gx1 += Math.round((want - gx1) / cell) * cell;
      while (gx1 > 0) gx1 -= cell;
      while (gx1 + F.cols * cell < cw) gx1 += cell;
    }

    // Scene 5 keeps the blend's 1:1 window: the rows around the name band,
    // right-aligned to the stations, where every job ends.
    const visRows1 = ch / cell;
    const top1 = Math.round(clamp(bandMid - visRows1 * 0.48, 0, Math.max(0, lastRow + 1 - visRows1)));
    const visCols1 = Math.ceil(cw / cell);
    const sr0 = clamp(top1 - 1, 0, F.rows - 1);
    const sr1 = Math.min(clamp(top1 + Math.ceil(visRows1) + 1, 0, F.rows - 1), lastRow);

    return {
      F, cell: cs, scale, gx, gy, lastRow, sub, subSim,
      cell1: cell, gx1, gy1: -top1 * cell,
      flat: {
        c0: clamp(Math.floor(-gx / cs) - 1, 0, F.cols - 1), c1: clamp(Math.ceil((cw - gx) / cs) + 1, 0, F.cols - 1),
        r0: clamp(Math.floor(-gy / cs) - 1, 0, F.rows - 1), r1: Math.min(clamp(Math.ceil((ch - gy) / cs) + 1, 0, F.rows - 1), lastRow),
      },
      sim: { c0: Math.max(0, F.cols - visCols1), c1: F.cols - 1, r0: sr0, r1: sr1 },
    };
  }
  // The stage's CSS grid: the opening floor's (possibly scaled) cells on scene 0
  // and in the still floor, the hero's own cell size on the other scenes.
  function setGridVars(G) {
    if (G) gridG = G;
    G = gridG;
    if (!G) return;
    const floorScene = activeSlot <= 0 || FALLBACK || !root.classList.contains("stage-live");
    const c = floorScene ? G.cell : G.cell1, x = floorScene ? G.gx : G.gx1, y = floorScene ? G.gy : G.gy1;
    const m = (v) => (((v % c) + c) % c);
    viewEl.style.setProperty("--cell", c.toFixed(3) + "px");
    viewEl.style.setProperty("--gx", m(x).toFixed(2) + "px");
    viewEl.style.setProperty("--gy", m(y).toFixed(2) + "px");
  }

  /* ===== The still floor: a placeholder while loading, the fallback without WebGL2 ===== */

  const sg = stillCv.getContext("2d");
  let stillG = null, stillOn = false;
  function drawStill() {
    if (!stillOn || !FS.ready) return;
    const b = viewEl.getBoundingClientRect();
    if (!b.width || !b.height) return;
    const k = Math.min(2, window.devicePixelRatio || 1);
    stillCv.width = Math.max(1, Math.round(b.width * k));
    stillCv.height = Math.max(1, Math.round(b.height * k));
    stillG = floorFrame(b.width, b.height);
    if (!stillG) return;
    setGridVars(stillG);
    FS.drawStill(sg, stillG.gx, stillG.gy, stillG.scale, k);
  }
  stillCv.addEventListener("click", (e) => {
    if (!stillG) return;
    const b = stillCv.getBoundingClientRect();
    FS.placeAtCell((e.clientX - b.left - stillG.gx) / stillG.cell, (e.clientY - b.top - stillG.gy) / stillG.cell);
    drawStill();
  });
  function showStill(reason, final) {
    if (final) {
      FALLBACK = true;
      root.classList.add("no-webgl");
      root.classList.remove("stage-live");
      sets.forEach((s, i) => { s.hidden = i !== 0; });
      labelEl.textContent = T.floorLabel;
      console.info("[stage] still fallback: " + reason);
    }
    if (stillOn) { drawStill(); return; }
    stillOn = true;
    stillCv.style.cursor = "crosshair";
    drawStill();
    addEventListener("floor:change", drawStill);
    new ResizeObserver(drawStill).observe(viewEl);
  }
  function fail(reason, err) {
    root.classList.add("stage-failed");
    console.warn("[stage] falling back to the still floor: " + reason, err || "");
    showStill(reason, true);
  }

  /* ===== Loader: Three.js only once the reader is on the way ===== */

  function webgl2() {
    if (params.has("nogl")) return false;
    try {
      const c = document.createElement("canvas");
      const gl = window.WebGL2RenderingContext && c.getContext("webgl2");
      const lose = gl && gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
      return !!gl;
    } catch (e) {
      return false;
    }
  }

  const api = {
    FS, root, section, stageEl, viewEl, footEl, labelEl, stepEls, SLOT_IDS, SYS, T,
    COARSE, REDUCED, DEBUG, params,
    measure, targetSlot, slotScrollY, floorFrame, setGridVars, fail,
    onSlot: (fn) => listeners.push(fn), scrollHooks,
    h, $,
  };

  let armed = false, near = false, loading = false;
  async function load() {
    if (loading) return;
    loading = true;
    if (!webgl2()) { showStill("WebGL2 unavailable" + (params.has("nogl") ? " (?nogl)" : ""), true); return; }
    showStill("placeholder while the WebGL stage loads", false);
    const t0 = performance.now();
    console.info("[stage] lazy load start: Three.js stage");
    let mod;
    try {
      mod = await import("./stage-gl.js");
    } catch (e) {
      fail("Three.js did not load", e);
      return;
    }
    console.info("[stage] lazy load finished in " + Math.round(performance.now() - t0) + " ms, starting the WebGL stage");
    try {
      await mod.startGL(api);
      console.info("[stage] WebGL stage live " + Math.round(performance.now() - t0) + " ms after the load started");
    } catch (e) {
      fail("scene error", e);
    }
  }
  function maybeLoad() { if (armed && near) load(); }
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      near = entries[entries.length - 1].isIntersecting;
      if (near) dbg("section near the viewport");
      maybeLoad();
      if (loading) io.disconnect();
    }, { rootMargin: LOAD_MARGIN });
    io.observe(section);
  } else {
    near = true;
  }
  // The hero is always at least a screen tall, so the section is never on screen
  // before the first scroll: arm on that scroll (or a restored scroll position),
  // and the first load stays free of Three.js.
  const arm = () => {
    if (armed) return;
    armed = true;
    dbg("armed");
    maybeLoad();
  };
  if (scrollY > 0) arm();
  else addEventListener("scroll", arm, { once: true, passive: true });

  // ?at=<scene id> scrolls straight to a scene, for review.
  const at = params.get("at");
  if (at && SLOT_IDS.includes(at)) {
    const go = () => {
      const y = slotScrollY(SLOT_IDS.indexOf(at));
      root.style.scrollBehavior = "auto";
      window.scrollTo(0, Math.max(0, y));
      root.style.scrollBehavior = "";
      console.info("[stage] ?at=" + at + ": scrolled to " + Math.round(y));
    };
    if (document.fonts) document.fonts.ready.then(() => setTimeout(go, 50));
    else setTimeout(go, 50);
  }

  if (REDUCED) console.info("[stage] reduced motion: the stage will render still frames on demand");
}
