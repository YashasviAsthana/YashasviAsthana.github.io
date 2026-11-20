# yashasviasthana.github.io

The personal site of Yashasvi Asthana: https://yashasviasthana.github.io/

A single static page built with [Astro](https://astro.build). The hero is a live
warehouse floor simulation: robots claim orders from the racks and carry them to
pick stations, and every job is planned with space-time A* against a shared
reservation table. Click or tap the floor to place an order. Zoom the browser out
and the floor grows, with a bigger fleet to match.

Further down, a framed stage follows the scroll through five systems as point
clouds drawn with [Three.js](https://threejs.org). It opens on the same live floor
as the hero (an order placed in either shows up in both), then morphs into each
system. Three.js is only downloaded once the reader scrolls toward that section.
Without WebGL2 the stage shows a still 2D frame of the floor, and without
JavaScript every system reads as plain text.

## Two variants of the Nimble section

The page builds in one of two variants, chosen at build time. Both share the hero,
the simulation and every other section; only the Nimble section differs.

| Variant | Build command | Nimble section |
| --- | --- | --- |
| E (default) | `npm run build` | the framed Three.js stage described above |
| A | `PUBLIC_VARIANT=a npm run build` | a list of the five systems driving a live 2D view of the floor |

`astro.config.mjs` reads `PUBLIC_VARIANT` and points two import aliases,
`@variant/nimble-section` and `@variant/nimble-script`, at that variant's component
and script, so the other variant's markup, styles and scripts never enter the
build (variant A does not ship Three.js at all). There is no `/a/` route: one build
is one variant. `npm run dev` follows the same variable; `npm run preview` serves
whichever variant was built last.

The original variant A source, as first built, is also kept as a frozen snapshot
outside this repository (a `site-a/` folder next to it).

## Run it locally

Needs Node 20.3 or newer (Node 22 works too) and npm.

```sh
npm install
npm run dev       # dev server at http://localhost:4321
npm run build     # static site in dist/
npm run preview   # serve dist/ locally
```

`npm run og` re-renders `public/og.png` (the 1200x630 social card) and
`public/apple-touch-icon.png` from the HTML pages in `scripts/og/`, using headless
Chrome (`google-chrome` on PATH, or set `CHROME=/path/to/chrome`).

Add `?debug` to the URL for planner debug logs and `window.__dispatch`, which can
fast-forward the simulation and count conflicts (`__dispatch.check(600)`) or report
frame and planner timings (`__dispatch.stats()`). `?debug` also exposes the stage as
`window.__stage`. `?at=floor|state|scheduling|assignment|rust|simulation` scrolls
straight to a stage scene, and `?nogl` forces the no-WebGL still frame.

## Layout

- `src/data/content.ts`: all of the page copy, as typed data.
- `src/components/`: the page sections (hero, Nimble, also building, path, contact, footer).
  `NimbleStage.astro` is variant E's Nimble section, `Nimble.astro` is variant A's.
- `src/scripts/dispatch.js`: the floor simulation and hero, plus variant A's live view;
  it hands variant E's stage the same floor.
- `src/scripts/variant-e.js`, `variant-a.js`: what each variant starts after the hero.
- `src/scripts/stage-story.js`: the stage frame, scroll story, controls, still fallback and lazy loader.
- `src/scripts/stage-gl.js`: the Three.js point-cloud scenes (loaded on demand as its own chunk).
- `src/scripts/topics.js`: the conversation starters and their small animations.
- `src/scripts/email.ts`: builds the email links in the browser, so the address is not in the HTML.
- `src/styles/`: design tokens and styles; `stage.css` is variant E's Nimble section only.
- `.github/workflows/deploy.yml`: builds and deploys to GitHub Pages on every push to `master`.

## About the illustrations

The fleet visuals on this site are illustrations written from scratch for this site,
using textbook techniques. They are not derived from Nimble's software, algorithms,
data, or warehouse layouts.

## Credits

Fonts: Unbounded, Onest and JetBrains Mono, self-hosted through Fontsource
(SIL Open Font License).
