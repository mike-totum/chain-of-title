import { config } from "./config.ts";
import { openDb } from "./db.ts";

const db = openDb(config.dbPath);
const hours = Number(process.argv[2] ?? "0") || 0;
const since = hours ? Date.now() - hours * 3600_000 : 0;

const q = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as any[])) as T[];
const one = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as any[])) as T;
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const f = (n: number | null | undefined, d = 3) => (n === null || n === undefined ? "-" : n.toFixed(d));
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const table = (rows: Record<string, string | number>[]) => {
  if (!rows.length) return console.log("  (none)");
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  console.log("  " + cols.map((c, i) => c.padEnd(w[i])).join("  "));
  for (const r of rows) console.log("  " + cols.map((c, i) => String(r[c]).padEnd(w[i])).join("  "));
};

console.log(`\n=== pump.fun paper-trading report${hours ? ` (last ${hours}h)` : ""} - ${config.dbPath} ===\n`);

// ---------- universe / base rates ----------
const u = one(
  `SELECT COUNT(*) n, SUM(finalized) fin, SUM(graduated) grad, SUM(dev_sold) devsold, SUM(late_discovery) late,
          SUM(CASE WHEN snap30_buyers >= 8 THEN 1 ELSE 0 END) active30,
          SUM(CASE WHEN p_5m > launch_price THEN 1 ELSE 0 END) up5, SUM(CASE WHEN p_5m IS NOT NULL THEN 1 ELSE 0 END) has5,
          SUM(CASE WHEN p_15m > launch_price THEN 1 ELSE 0 END) up15, SUM(CASE WHEN p_15m IS NOT NULL THEN 1 ELSE 0 END) has15,
          SUM(CASE WHEN p_60m > launch_price THEN 1 ELSE 0 END) up60, SUM(CASE WHEN p_60m IS NOT NULL THEN 1 ELSE 0 END) has60,
          SUM(CASE WHEN peak_price >= 2*launch_price THEN 1 ELSE 0 END) hit2x,
          SUM(CASE WHEN peak_price >= 5*launch_price THEN 1 ELSE 0 END) hit5x,
          MIN(created_at) first_at, MAX(created_at) last_at
   FROM tokens WHERE created_at >= ? AND late_discovery = 0`,
  since,
);
const span = u.last_at && u.first_at ? (u.last_at - u.first_at) / 3600_000 : 0;
console.log("UNIVERSE (every launch seen)");
table([
  { metric: "launches seen", value: u.n },
  { metric: "observation span", value: `${span.toFixed(2)} h  (${span ? (u.n / span).toFixed(0) : "-"} launches/hour)` },
  { metric: "finished watch window", value: u.fin ?? 0 },
  { metric: "graduated (left bonding curve)", value: `${u.grad ?? 0}  (${pct(u.grad, u.n)})` },
  { metric: "dev sold within window", value: `${u.devsold ?? 0}  (${pct(u.devsold, u.n)})` },
  { metric: ">= 8 distinct buyers in first 30s", value: `${u.active30 ?? 0}  (${pct(u.active30, u.n)})` },
  { metric: "price above launch at 5m", value: `${u.up5 ?? 0} / ${u.has5 ?? 0}  (${pct(u.up5, u.has5)})` },
  { metric: "price above launch at 15m", value: `${u.up15 ?? 0} / ${u.has15 ?? 0}  (${pct(u.up15, u.has15)})` },
  { metric: "price above launch at 60m", value: `${u.up60 ?? 0} / ${u.has60 ?? 0}  (${pct(u.up60, u.has60)})` },
  { metric: "ever reached 2x launch price", value: `${u.hit2x ?? 0}  (${pct(u.hit2x, u.n)})` },
  { metric: "ever reached 5x launch price", value: `${u.hit5x ?? 0}  (${pct(u.hit5x, u.n)})` },
]);
const mult = q<{ m1: number; m5: number; m15: number; m60: number }>(
  `SELECT p_1m/launch_price m1, p_5m/launch_price m5, p_15m/launch_price m15, p_60m/launch_price m60 FROM tokens WHERE created_at >= ? AND launch_price > 0 AND late_discovery=0`,
  since,
);
console.log(`\n  median price multiple vs launch:  1m ${f(median(mult.map((r) => r.m1).filter(Number.isFinite)), 2)}   5m ${f(median(mult.map((r) => r.m5).filter(Number.isFinite)), 2)}   15m ${f(median(mult.map((r) => r.m15).filter(Number.isFinite)), 2)}   60m ${f(median(mult.map((r) => r.m60).filter(Number.isFinite)), 2)}`);

// ---------- strategies ----------
console.log("\nSTRATEGIES (paper, per-trade size " + config.buySol + " SOL, fees included)");
const strats = q<{ strategy: string }>(`SELECT DISTINCT strategy FROM positions WHERE decided_at >= ? ORDER BY strategy`, since).map((r) => r.strategy);
const rows: Record<string, string | number>[] = [];
for (const s of strats) {
  const a = one(
    `SELECT COUNT(*) n, SUM(closed_at IS NULL) open, SUM(exit_reason='shutdown') shut,
            SUM(CASE WHEN closed_at IS NOT NULL AND exit_reason!='shutdown' THEN 1 ELSE 0 END) closed,
            SUM(CASE WHEN closed_at IS NOT NULL AND exit_reason!='shutdown' AND pnl_sol>0 THEN 1 ELSE 0 END) wins,
            SUM(CASE WHEN closed_at IS NOT NULL AND exit_reason!='shutdown' THEN pnl_sol ELSE 0 END) pnl,
            SUM(CASE WHEN closed_at IS NOT NULL AND exit_reason!='shutdown' THEN sol_in ELSE 0 END) risked,
            AVG(CASE WHEN closed_at IS NOT NULL AND exit_reason!='shutdown' THEN multiple END) avgx,
            MAX(multiple) best, MIN(CASE WHEN exit_reason!='shutdown' THEN multiple END) worst,
            AVG(peak_multiple) avgpeak,
            AVG(hold_5m) h5, AVG(hold_15m) h15, AVG(hold_60m) h60,
            AVG(token_age_s) age
     FROM positions WHERE strategy=? AND decided_at >= ? AND suspect = 0`,
    s, since,
  );
  // "if held" = token price at t+N after LAUNCH divided by our entry price, for every entry (not just ones still open then)
  const held = one(
    `SELECT AVG(t.p_5m / p.entry_price) h5, AVG(t.p_15m / p.entry_price) h15, AVG(t.p_60m / p.entry_price) h60,
            SUM(CASE WHEN t.p_15m / p.entry_price > 1.05 THEN 1 ELSE 0 END) up15, SUM(t.p_15m IS NOT NULL) n15
     FROM positions p JOIN tokens t ON t.mint = p.mint WHERE p.strategy=? AND p.decided_at >= ? AND p.entry_price > 0 AND p.suspect = 0`,
    s, since,
  );
  const med = median(q<{ m: number }>(`SELECT multiple m FROM positions WHERE strategy=? AND decided_at>=? AND closed_at IS NOT NULL AND exit_reason!='shutdown' AND suspect = 0`, s, since).map((r) => r.m));
  rows.push({
    strategy: s,
    entries: a.n,
    closed: a.closed ?? 0,
    open: a.open ?? 0,
    "win%": pct(a.wins, a.closed),
    "pnl SOL": (a.pnl >= 0 ? "+" : "") + f(a.pnl),
    "return%": a.risked ? `${((100 * a.pnl) / a.risked).toFixed(1)}%` : "-",
    "avg x": f(a.avgx, 2),
    "med x": f(med, 2),
    best: f(a.best, 2),
    worst: f(a.worst, 2),
    "avg peak": f(a.avgpeak, 2),
    "ifheld5m": f(held.h5, 2),
    "ifheld15m": f(held.h15, 2),
    "ifheld60m": f(held.h60, 2),
    "up@15m": pct(held.up15, held.n15),
    "entry age": `${f(a.age, 0)}s`,
  });
}
table(rows);
const susp = one(`SELECT COUNT(*) n, ROUND(SUM(pnl_sol),1) pnl FROM positions WHERE decided_at >= ? AND suspect = 1`, since);
if (susp?.n) console.log(`  ${susp.n} position(s) flagged suspect (multiple > 50x, a price-source artifact) and excluded above; their nominal PnL was ${susp.pnl} SOL.`);
console.log("  ifheld5m/15m/60m = avg (token price N min after launch / our entry price) over every entry - the no-exit-rules outcome; up@15m = share of entries above entry price at 15m");

for (const s of strats) {
  const ex = q<{ exit_reason: string; n: number; pnl: number }>(
    `SELECT exit_reason, COUNT(*) n, SUM(pnl_sol) pnl FROM positions WHERE strategy=? AND decided_at>=? AND closed_at IS NOT NULL AND suspect = 0 GROUP BY exit_reason ORDER BY n DESC`,
    s, since,
  );
  if (ex.length) console.log(`\n  ${s} exits: ` + ex.map((e) => `${e.exit_reason} ${e.n} (${e.pnl >= 0 ? "+" : ""}${f(e.pnl)})`).join(", "));
}

// ---------- KOL signals ----------
const sig = q(
  `SELECT s.seen_at, s.account, s.kind, s.symbol, s.mint, t.symbol tsym, t.peak_price, t.last_price, t.launch_price
   FROM signals s LEFT JOIN tokens t ON t.mint = s.mint WHERE s.seen_at >= ? ORDER BY s.seen_at DESC LIMIT 25`,
  since,
);
console.log(`\nKOL SIGNALS (${one(`SELECT COUNT(*) n FROM signals WHERE seen_at>=?`, since).n} total)`);
table(
  sig.map((r) => ({
    time: new Date(r.seen_at).toISOString().slice(5, 16),
    account: "@" + r.account,
    kind: r.kind,
    token: r.tsym ?? (r.symbol ? "$" + r.symbol : "-"),
    mint: r.mint ? r.mint.slice(0, 6) + "…" : "-",
    "peak x": r.launch_price ? f(r.peak_price / r.launch_price, 2) : "-",
    "now x": r.launch_price ? f(r.last_price / r.launch_price, 2) : "-",
  })),
);

// ---------- per-account outcomes of the kol-signal strategy ----------
const byAcct = q(
  `SELECT s.account,
          COUNT(DISTINCT s.mint) signals,
          COUNT(p.id) trades,
          SUM(CASE WHEN p.closed_at IS NOT NULL AND p.exit_reason!='shutdown' THEN 1 ELSE 0 END) closed,
          SUM(CASE WHEN p.closed_at IS NOT NULL AND p.exit_reason!='shutdown' AND p.pnl_sol>0 THEN 1 ELSE 0 END) wins,
          SUM(CASE WHEN p.closed_at IS NOT NULL AND p.exit_reason!='shutdown' THEN p.pnl_sol ELSE 0 END) pnl,
          AVG(CASE WHEN p.closed_at IS NOT NULL AND p.exit_reason!='shutdown' THEN p.multiple END) avgx,
          AVG(p.peak_multiple) avgpeak,
          AVG(CASE WHEN t.late_discovery = 0 THEN (s.posted_at - t.created_at)/60000.0 END) lead_min,
          SUM(CASE WHEN t.late_discovery = 0 AND s.posted_at < t.created_at THEN 1 ELSE 0 END) pre_launch
   FROM signals s
   LEFT JOIN tokens t ON t.mint = s.mint
   LEFT JOIN positions p ON p.mint = s.mint AND p.strategy = 'kol-signal' AND p.decided_at >= s.seen_at - 5000 AND p.suspect = 0
   WHERE s.seen_at >= ? AND s.mint IS NOT NULL
   GROUP BY s.account ORDER BY pnl DESC`,
  since,
);
if (byAcct.length) {
  console.log("\nKOL-SIGNAL OUTCOMES BY ACCOUNT (paper)");
  table(
    byAcct.map((r) => ({
      account: r.account,
      signals: r.signals,
      trades: r.trades,
      closed: r.closed ?? 0,
      "win%": pct(r.wins, r.closed),
      "pnl SOL": r.pnl === null ? "-" : (r.pnl >= 0 ? "+" : "") + f(r.pnl),
      "avg x": f(r.avgx, 2),
      "avg peak": f(r.avgpeak, 2),
      "avg lead": r.lead_min === null ? "-" : `${f(r.lead_min, 1)}m`,
      "pre-launch": r.pre_launch ?? 0,
    })),
  );
  console.log("  avg lead = minutes between token launch and the post, only for tokens the monitor saw launch (negative = posted before launch); pre-launch = count of such posts");
}

// ---------- recent trades ----------
console.log("\nRECENT PAPER TRADES");
const recent = q(
  `SELECT strategy, symbol, mint, opened_at, closed_at, multiple, pnl_sol, exit_reason, peak_multiple, token_age_s FROM positions WHERE decided_at>=? AND suspect = 0 ORDER BY id DESC LIMIT 20`,
  since,
);
table(
  recent.map((r) => ({
    strategy: r.strategy,
    token: r.symbol,
    mint: r.mint.slice(0, 6) + "…",
    "age@entry": `${f(r.token_age_s, 0)}s`,
    held: r.closed_at ? `${((r.closed_at - r.opened_at) / 1000).toFixed(0)}s` : "open",
    x: f(r.multiple, 2),
    pnl: r.pnl_sol === null ? "-" : (r.pnl_sol >= 0 ? "+" : "") + f(r.pnl_sol, 4),
    peak: f(r.peak_multiple, 2),
    exit: r.exit_reason ?? "-",
  })),
);
console.log();
