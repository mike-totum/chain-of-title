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
