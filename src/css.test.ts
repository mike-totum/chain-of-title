/**
 * The CSS lives inside a template literal, so a backtick in one of its comments silently ends the string and the
 * next brace is parsed as TypeScript. It fails at build time with a message pointing at a CSS line and no
 * explanation, which has now cost two debugging rounds. Cheaper to assert it.
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

test("the CSS template literal contains no backticks or unescaped interpolations", () => {
  const src = readFileSync(new URL("./render.ts", import.meta.url), "utf8");
  const open = src.indexOf("export const CSS = `");
  assert.ok(open >= 0, "could not find the CSS block");
  const body = src.slice(open + "export const CSS = `".length);
  const css = body.slice(0, body.indexOf("\n`;"));
  assert.equal(css.includes("`"), false, "a backtick in the CSS block ends the template literal early");
  assert.equal(/\$\{/.test(css), false, "an interpolation in the CSS block is almost certainly a typo");
});
