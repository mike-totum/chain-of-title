/**
 * The two properties of the usage counter that are not allowed to drift.
 *
 * One is a privacy guarantee and the other is a coverage guarantee, and both are the kind of thing that is true when
 * written and quietly false a month later. `classify` is the only place a path is turned into a stored value, so a
 * new route that returns the path itself would put mints and wallet addresses in the file; and the counter is only
 * worth having if every response reaches it, including the routes that never call `send`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdirSync } from "node:fs";

const KINDS = new Set(["home", "record", "wallet", "operator", "report", "prose", "api_token", "api_wallet",
  "api_status", "api_live", "api_other", "bulk_record", "bulk_documents", "image", "static", "other"]);

test("classify never returns anything but a fixed route class, whatever the path", async () => {
  const { classify } = await import("./usage.ts");
  const MINT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const paths = ["/", "/index.html", `/t/${MINT}`, `/${MINT}`, `/api/v1/token/${MINT}`, `/api/v1/wallet/${MINT}`,
    "/api/v1/status", "/api/live/recent", "/data/record.db", "/data/documents.ndjson.gz", "/method.html",
    "/reports/x.html", "/w/abc", "/o/abc", "/i/abc.png", "/style.css", "/nonsense", "/../../etc/passwd",
    `/weird/${MINT}?q=${MINT}`, "/" + "a".repeat(500)];
  for (const p of paths) {
    const k = classify(p);
    assert.ok(KINDS.has(k), `classify(${p.slice(0, 40)}) returned ${k}, which is not a known route class`);
    // The guarantee that matters: whatever comes back must not carry the path with it.
    assert.ok(!k.includes(MINT), `classify leaked a mint address into its return value for ${p}`);
  }
});

test("obvious crawlers are counted as automated and a browser is not", async () => {
  const { looksAutomated } = await import("./usage.ts");
  for (const ua of ["Googlebot/2.1", "python-requests/2.31", "curl/8.4.0", "node-fetch/1.0", undefined])
    assert.equal(looksAutomated(ua), true, `${ua} should count as automated`);
  assert.equal(looksAutomated(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"),
    false, "a plain desktop browser should not count as automated");
});

test("a response that never calls send() is still counted, and no identifier is stored", async () => {
  const dir = join(tmpdir(), `cot-usage-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "usage.db");
  process.env.USAGE_PATH = path;
  const usage = await import("./usage.ts");
  assert.ok(usage.start(join(dir, "record.db"), 1_000_000), "counter should open a database");

  const srv = createServer((req, res) => {
    res.on("finish", () => usage.note(new URL(req.url ?? "/", "http://x").pathname, res.statusCode,
      req.headers["user-agent"]));
    // Deliberately bypasses any send helper, exactly as the real /index.html redirect does.
    if (req.url === "/index.html") { res.writeHead(301, { location: "/" }); return res.end(); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<p>ok");
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as any).port;
  const ua = { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36" };
  await fetch(`http://127.0.0.1:${port}/index.html`, { headers: ua, redirect: "manual" });
  await fetch(`http://127.0.0.1:${port}/`, { headers: ua });
  await new Promise((r) => setTimeout(r, 150));
  usage.stop();
  srv.close();

  const db = new DatabaseSync(path, { readOnly: true });
  const cols = (db.prepare("SELECT name FROM pragma_table_info('usage')").all() as any[]).map((r) => r.name);
  assert.deepEqual(cols.sort(), ["automated", "day", "kind", "n", "status"],
    "the usage table grew a column; anything beyond these five risks holding an identifier");
  const rows = db.prepare("SELECT kind, status, n FROM usage").all() as any[];
  assert.ok(rows.some((r) => r.status === 301),
    "the 301 bypasses send(), so a counter wired into send() would miss it - it must be counted here");
  assert.ok(rows.some((r) => r.status === 200 && r.kind === "home"), "the ordinary response should be counted too");
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.USAGE_PATH;
});
