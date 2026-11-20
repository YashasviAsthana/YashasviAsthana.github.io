// Renders the social card (public/og.png, 1200x630) and the Apple touch icon
// (public/apple-touch-icon.png, 180x180) from the HTML pages next to this file,
// using headless Chrome. Run with `npm run og` after `npm install`.
// Set CHROME=/path/to/chrome if google-chrome is not on PATH.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = resolve(here, "../../public");
const chrome = process.env.CHROME || "google-chrome";

const jobs = [
  { src: "og.html", out: "og.png", w: 1200, h: 630 },
  { src: "icon.html", out: "apple-touch-icon.png", w: 180, h: 180 },
];

for (const job of jobs) {
  const profile = mkdtempSync(join(tmpdir(), "og-chrome-"));
  const out = join(pub, job.out);
  const url = pathToFileURL(join(here, job.src)).href;
  console.info(`[og] rendering ${job.src} at ${job.w}x${job.h}`);
  execFileSync(chrome, [
    "--headless=new",
    "--hide-scrollbars",
    "--allow-file-access-from-files",
    "--force-device-scale-factor=1",
    `--user-data-dir=${profile}`,
    `--window-size=${job.w},${job.h}`,
    "--virtual-time-budget=8000",
    `--screenshot=${out}`,
    url,
  ], { stdio: ["ignore", "ignore", "ignore"] });
  rmSync(profile, { recursive: true, force: true });
  console.info(`[og] wrote ${out} (${statSync(out).size} bytes)`);
}
