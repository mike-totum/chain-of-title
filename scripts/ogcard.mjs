/**
 * Renders scripts/ogcard.html to assets/og.png (1200x630), the link-preview card every page points at.
 *
 * A record link pasted into a chat is this project's only real distribution, and with no card each one arrived as a
 * bare grey box. The card is brand-level and static; the specific finding travels in og:title and og:description,
 * which is the half that carries the argument and cannot say anything the record does not.
 *
 * Maintainer tool, not part of the build or the image: it needs a real browser. Run it when the mark or the wording
 * changes, and commit the PNG.
 *   node scripts/ogcard.mjs        (needs playwright + a local Chrome)
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "assets", "og.png");
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto("file://" + join(here, "ogcard.html"), { waitUntil: "networkidle" });
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
