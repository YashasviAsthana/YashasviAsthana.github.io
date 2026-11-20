// Assembles the email address in the browser, so it never appears in the HTML
// or the bundle as plaintext. The encoded form lives in content.ts.
import { emailCode } from "../data/content";

let cached = "";

/** The plain address, decoded once. */
export function emailAddress(): string {
  if (!cached) {
    cached = Array.from(emailCode)
      .reverse()
      .map((ch) => String.fromCharCode(ch.charCodeAt(0) - 1))
      .join("");
  }
  return cached;
}

/** A mailto: URL, with an optional subject line. */
export function mailto(subject?: string): string {
  const base = "mailto:" + emailAddress();
  return subject ? base + "?subject=" + encodeURIComponent(subject) : base;
}

/** Points every [data-mailto] link (the Email buttons) at the address. */
export function initEmailLinks(): void {
  const links = document.querySelectorAll<HTMLAnchorElement>("a[data-mailto]");
  links.forEach((a) => {
    a.href = mailto();
  });
  console.info("[email] mailto links assembled", { links: links.length });
}
