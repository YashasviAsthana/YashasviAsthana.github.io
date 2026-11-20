// Types for the build-time variant aliases set in astro.config.mjs.
declare module "@variant/nimble-section" {
  const Section: (props: Record<string, never>) => unknown;
  export default Section;
}
declare module "@variant/nimble-script" {
  export const VARIANT: "a" | "e";
  export const TOPICS: { drawnArrow?: boolean };
  export function initNimble(floor: unknown): void;
}
