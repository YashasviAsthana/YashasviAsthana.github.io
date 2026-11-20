// Variant A: dispatch.js draws the Nimble section's live view itself, so there
// is nothing more to start, and the contact starters keep the typed arrow.
// Selected with PUBLIC_VARIANT=a at build time (see astro.config.mjs).
export const VARIANT = "a";
export const TOPICS = {};
export function initNimble() {
  console.info("[variant] A: live view in the Nimble section");
}
