/**
 * Operational alerting via Telegram.
 *
 * `Alerter.send(id, message)` posts to a Telegram chat, de-duplicated by `id` with a cooldown
 * so a persistent condition (e.g. a depleted treasury seen every health cycle) fires once per
 * window instead of spamming. When the bot token / chat id are unset, `createAlerter` returns a
 * no-op so the rest of the system runs unchanged.
 *
 * The Telegram fetch targets api.telegram.org (a fixed, trusted host) — it is unrelated to the
 * SSRF-validated user `X-Rpc-Url` path and never carries user-controlled URLs.
 */

import { withTimeout } from "../utils/timeout.ts";
import { redactError } from "../reliability/log.ts";

export interface Alerter {
  /** Send `message`, deduped by `id` within the cooldown window. Never throws. */
  send(id: string, message: string): Promise<void>;
}

/** Default: don't re-send the same alert id more than once per 30 minutes. */
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const TELEGRAM_TIMEOUT_MS = 8_000;

export class NoopAlerter implements Alerter {
  send(_id: string, _message: string): Promise<void> {
    return Promise.resolve();
  }
}

export class TelegramAlerter implements Alerter {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly lastSent = new Map<string, number>();

  constructor(params: {
    botToken: string;
    chatId: string;
    cooldownMs?: number;
    /** Injectable clock for tests. */
    now?: () => number;
  }) {
    this.botToken = params.botToken;
    this.chatId = params.chatId;
    this.cooldownMs = params.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = params.now ?? (() => Date.now());
  }

  async send(id: string, message: string): Promise<void> {
    const now = this.now();
    const last = this.lastSent.get(id);
    if (last !== undefined && now - last < this.cooldownMs) return; // within cooldown — skip
    // Record BEFORE awaiting so concurrent health cycles don't double-fire the same id.
    this.lastSent.set(id, now);

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    try {
      const res = await withTimeout(
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.chatId, text: message, disable_web_page_preview: true }),
        }),
        TELEGRAM_TIMEOUT_MS,
        "telegram.sendMessage",
      );
      if (!res.ok) {
        // Allow a retry next window if the send failed (don't hold the cooldown on failure).
        this.lastSent.delete(id);
        const body = await res.text().catch(() => "");
        console.warn(`[Alert] Telegram send failed (${res.status}): ${body.slice(0, 200)}`);
      }
    } catch (err) {
      this.lastSent.delete(id);
      // redactError: a fetch/timeout error message embeds the request URL, which contains the
      // bot token (…/bot<TOKEN>/sendMessage). Never log it raw.
      console.warn(`[Alert] Telegram send error: ${redactError(err)}`);
    }
  }
}

/** Build an Alerter from config: Telegram when both token + chatId are set, else a no-op. */
export function createAlerter(
  config: { telegramBotToken: string | null; telegramChatId: string | null },
  opts?: { cooldownMs?: number; now?: () => number },
): Alerter {
  if (config.telegramBotToken && config.telegramChatId) {
    return new TelegramAlerter({
      botToken: config.telegramBotToken,
      chatId: config.telegramChatId,
      cooldownMs: opts?.cooldownMs,
      now: opts?.now,
    });
  }
  return new NoopAlerter();
}
