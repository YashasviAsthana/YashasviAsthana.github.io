// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { fileURLToPath } from "node:url";

// Page variant, chosen at build time:
//   npm run build                     variant E (default): the Nimble stage
//   PUBLIC_VARIANT=a npm run build    variant A: the Nimble list and live view
// The two @variant/* aliases point index.astro at that variant's section and
// script, so the other variant's markup, styles and scripts (and, for A,
// Three.js) never enter the build. There is no /a/ route.
const VARIANT = (process.env.PUBLIC_VARIANT || "e").trim().toLowerCase() === "a" ? "a" : "e";
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
console.info(`[variant] building variant ${VARIANT.toUpperCase()}` + (VARIANT === "a" ? " (Nimble list and live view)" : " (Nimble stage)"));

// Static site for GitHub Pages, served from the root of the user site.
export default defineConfig({
  site: "https://yashasviasthana.github.io",
  output: "static",
  trailingSlash: "ignore",
  integrations: [sitemap()],
  build: {
    // One small stylesheet: inline it so the first paint does not wait on a request.
    inlineStylesheets: "always",
  },
  devToolbar: { enabled: false },
  vite: {
    resolve: {
      alias: {
        "@variant/nimble-section": here(VARIANT === "a" ? "./src/components/Nimble.astro" : "./src/components/NimbleStage.astro"),
        "@variant/nimble-script": here(VARIANT === "a" ? "./src/scripts/variant-a.js" : "./src/scripts/variant-e.js"),
      },
    },
    build: {
      // Variant E's Three.js stage chunk (about 520 kB raw, 140 kB gzipped) is
      // loaded on demand when the reader scrolls toward the Nimble section,
      // never on first load, so its size is expected.
      chunkSizeWarningLimit: 600,
    },
  },
});
