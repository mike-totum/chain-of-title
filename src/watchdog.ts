/**
 * A watch that keeps working when the laptop is closed.
 *
 * Until now every check that could notice this product had stopped ran on one personal machine: `run-freshness.sh`
 * under launchd, hourly, against the live URL. It could not fire during the failure it exists to catch, because the
 * commonest cause of the site freezing IS the laptop being asleep — and a sleeping machine runs no timers and sends
 * no alerts. On 2026-09-08 it went five hours between runs without anyone knowing, which is exactly the seven-hour
 * frozen archive of the day before, one level up: the watcher itself had the failure mode of the thing it watched.
 *
 * So the watch moves into the two processes that are always up, and it is deliberately TWO watches asking the same
 * question from different places:
 *
 *   web       — how old is the record I am serving? Catches a pull that stopped working, a collector that stopped
 *               building, an archive frozen while every route still answers 200. Cannot report its own death.
 *   collector — is the public site reachable, and is the record it serves advancing? Runs in a different service,
 *               different container, and reaches the site the way a visitor does. This is the one that survives the
 *               web service being dead, which is the case the self-check structurally cannot cover.
 *
 * Neither covers the whole platform going down. Nothing running inside it can. `startHeartbeat` is the answer to
 * that: point HEARTBEAT_URL at an external dead-man switch and the absence of a ping becomes the alert, sent by
 * infrastructure this project does not run.
 *
 * The state machine below exists because an alert channel that cries wolf gets muted, and a muted channel is worse
 * than none — it manufactures the belief that someone is watching. Hence: N consecutive failures before alarming,
 * one alarm then a repeat only every `repeatMs`, and an explicit recovery notice so that silence-after-an-alarm can
 * be told apart from an alarm that stopped working.
 */

/** `ok: false` means the thing being watched is wrong, not that the check could not run. Both alarm; see `tick`. */
export type ProbeResult = { ok: boolean; detail: string };

export type WatchdogOptions = {
  /** Appears in every log line and every message. Say what is being watched, not what the code is. */
  name: string;
  everyMs: number;
  /**
   * How many consecutive failures before the first alarm. 1 for a local check that cannot blip; 3 for anything
   * crossing a network, where a single timeout means nothing and alarming on it trains the reader to ignore alarms.
   */
  failuresBeforeAlarm: number;
  /** While a failure persists, say so again this often. Not more; a repeating alarm is a muted alarm. */
  repeatMs: number;
  probe: () => Promise<ProbeResult>;
  /** Must resolve `true` only if the message was actually delivered. Resolving `true` blind is the failure this
   *  project has already shipped once: `notify-summary.ts` exited 0 for weeks while sending nothing. */
  send: (text: string) => Promise<boolean>;
  log?: (line: string) => void;
};

export function startWatchdog(o: WatchdogOptions): void {
  const log = o.log ?? ((l: string) => console.log(l));
  let consecutive = 0;
  let alarmed = false;
  let lastAlarmAt = 0;

  /**
   * A message that could not be delivered is logged at full volume rather than swallowed. The logs are not a
   * notification channel — nobody is reading them at 3am, which is the whole reason this file exists — but an
   * undelivered alert that leaves no trace at all is how you discover months later that the channel was never wired.
   */
  const announce = async (text: string) => {
    let delivered = false;
    try { delivered = await o.send(text); } catch (e) { log(`[watch:${o.name}] send threw: ${(e as Error).message}`); }
    log(delivered ? `[watch:${o.name}] NOTIFIED: ${text}` : `[watch:${o.name}] ALERT UNDELIVERED: ${text}`);
  };

  const tick = async () => {
    let r: ProbeResult;
    /**
     * A probe that throws is a failed probe, never a skipped one. The tempting `catch { return }` turns every
     * unexpected error — a DNS failure, a JSON shape change, a bug in the probe itself — into silence, and silence
     * here reads as health. Absence of data reading as absence of problems is the shape of every serious bug in
     * this codebase.
     */
    try { r = await o.probe(); }
    catch (e) { r = { ok: false, detail: `check could not run: ${(e as Error).message}` }; }

    if (r.ok) {
      const wasAlarmed = alarmed;
      consecutive = 0;
      alarmed = false;
      log(`[watch:${o.name}] ok — ${r.detail}`);
      if (wasAlarmed) await announce(`RECOVERED — ${o.name}: ${r.detail}`);
      return;
    }

    consecutive++;
    log(`[watch:${o.name}] FAIL (${consecutive}) — ${r.detail}`);
    if (consecutive < o.failuresBeforeAlarm) return;
    if (alarmed && Date.now() - lastAlarmAt < o.repeatMs) return;
    alarmed = true;
    lastAlarmAt = Date.now();
    await announce(`${o.name}: ${r.detail}`);
  };

  setInterval(() => void tick(), o.everyMs);
  void tick();   // and once now, so a broken watch is visible in the boot logs rather than an interval later
}

/**
 * Ping an external dead-man switch (healthchecks.io, Better Stack, cron-monitor — anything that alerts on a ping
 * that does not arrive).
 *
 * Every check in this file runs inside the system it watches, so all of them go quiet together if Railway drops the
 * project, the account lapses, or a deploy crash-loops both services. That silence is indistinguishable from
 * everything being fine. Inverting it — where the ABSENCE of a signal is the alarm, judged by a third party — is the
 * only construction that survives its own subject dying, and it is four lines.
 */
export function startHeartbeat(url: string, everyMs: number, name: string): void {
  if (!url) return;
  const ping = async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) console.log(`[heartbeat:${name}] ${url} answered ${res.status}`);
    } catch (e) { console.log(`[heartbeat:${name}] failed: ${(e as Error).message}`); }
  };
  setInterval(() => void ping(), everyMs);
  void ping();
}

/** "4h 12m", for a message a human reads on a phone. */
export function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
