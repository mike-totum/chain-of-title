#!/bin/zsh
# Finish Telegram alerting once TELEGRAM_BOT_TOKEN is in .env: find the chat id, write it, and prove a message lands.
#
# Why a script rather than instructions: the chat id is not something a person reads off a screen. It comes back from
# getUpdates after you have messaged the bot, and the failure modes are specific and easy to misread — an empty
# result means "you have not messaged the bot yet", not "the token is wrong", and those want different fixes.
#
# The last step sends a real message on purpose. A notification channel that has never carried a message is not a
# channel, it is an assumption, and this project has been running on exactly that assumption for days.
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

tok=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' .env | head -1 | tr -d '"'"'"' ')
[ -n "$tok" ] || { echo "FAIL  TELEGRAM_BOT_TOKEN is empty in .env. Paste the token from @BotFather first."; exit 1; }

who=$(curl -s --max-time 20 "https://api.telegram.org/bot${tok}/getMe")
case "$who" in
  *'"ok":true'*) echo "bot:  @$(printf '%s' "$who" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')" ;;
  *) echo "FAIL  the token is not valid. Telegram said: $(printf '%s' "$who" | head -c 200)"; exit 1 ;;
esac

# The chat id only exists once a human has sent the bot a message: bots cannot open a conversation.
ups=$(curl -s --max-time 20 "https://api.telegram.org/bot${tok}/getUpdates")
chat=$(printf '%s' "$ups" | sed -n 's/.*"chat":{"id":\(-\{0,1\}[0-9]*\).*/\1/p' | head -1)
if [ -z "$chat" ]; then
  echo "FAIL  no messages yet, so there is no chat id to read."
  echo "      Open Telegram, find the bot above, and send it any message. Then run this again."
  exit 1
fi
echo "chat: $chat"

if grep -q '^TELEGRAM_CHAT_ID=' .env; then
  # In place, keeping the file's order. BSD sed needs the empty -i argument.
  sed -i '' "s/^TELEGRAM_CHAT_ID=.*/TELEGRAM_CHAT_ID=${chat}/" .env
else
  printf 'TELEGRAM_CHAT_ID=%s\n' "$chat" >> .env
fi
echo "wrote TELEGRAM_CHAT_ID to .env"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  "https://api.telegram.org/bot${tok}/sendMessage" \
  --data-urlencode "chat_id=${chat}" \
  --data-urlencode "text=✅ Chain of Title alerts are connected. This channel now carries: freshness (hourly), operator-cluster buyouts, and the daily report.")
[ "$code" = "200" ] || { echo "FAIL  token and chat id look right but sendMessage returned http $code"; exit 1; }
echo "PASS  test message delivered — check Telegram."
