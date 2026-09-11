/** Fire-and-forget Telegram bot alert. No-op when not configured. */
export function telegramNotifier(token: string, chatId: string): (text: string) => void {
  if (!token || !chatId) return () => {};
  return (text) => {
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
  };
}

/**
 * The same send, awaited, reporting whether Telegram actually accepted it.
 *
 * `telegramNotifier` above is fire-and-forget with a `.catch(() => {})`, which is right for a per-token signal
 * nobody acts on and wrong for an alert: a notifier that cannot tell you it failed manufactures the evidence that
 * someone was told. `notify-summary.ts` did exactly that for weeks - `process.exit(0)` when unconfigured, so the
 * morning report logged a successful notification every day and sent nothing.
 *
 * Returns false rather than throwing, including when unconfigured, so the caller decides how loud that is.
 */
export async function telegramSend(token: string, chatId: string, text: string): Promise<boolean> {
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch { return false; }
}
