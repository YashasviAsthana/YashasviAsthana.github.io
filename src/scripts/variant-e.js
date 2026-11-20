// Variant E (the default): the Nimble stage reads the hero's floor through the
// object initDispatch() returns, and the "Start here" arrow is drawn as SVG.
// Three.js stays out of this bundle: stage-story.js imports it on demand.
import { initStage } from "./stage-story";

export const VARIANT = "e";
export const TOPICS = { drawnArrow: true };
export function initNimble(floor) {
  console.info("[variant] E: Nimble stage");
  if (floor) initStage(floor);
}
