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
  /**
   * Send `message`, deduped by `id` within the cooldown window (per-call override via
   * `opts.cooldownMs` — money-stuck P1 conditions use a shorter window). Never throws.
   * `opts.noEscalation` suppresses the "STILL FIRING — reminder #N" repeat prefix for
   * routine periodic messages (heartbeats) that are NOT incidents.
   * Returns true when the message was delivered (or dedup-skipped — i.e. handled), false
   * when delivery FAILED — callers with their own cadence (the heartbeat) retry on false.
   */
  send(id: string, message: string, opts?: { cooldownMs?: number; noEscalation?: boolean }): Promise<boolean>;
  /** True when this alerter actually delivers (Telegram configured); false for the no-op.
   *  Surfaced in /health and startup logs so "alerting silently off" is impossible. */
  readonly enabled: boolean;
}

/** Default: don't re-send the same alert id more than once per 30 minutes. */
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const TELEGRAM_TIMEOUT_MS = 8_000;

export class NoopAlerter implements Alerter {
  readonly enabled = false;
  send(_id: string, _message: string, _opts?: { cooldownMs?: number; noEscalation?: boolean }): Promise<boolean> {
    // "Handled" — alerting is deliberately disabled; periodic callers must not spin-retry.
    return Promise.resolve(true);
  }
}

export class TelegramAlerter implements Alerter {
  readonly enabled = true;
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  /** Per-id last-send time + occurrence count. The count lets a PERSISTING condition
   *  escalate ("STILL STUCK — reminder #N") instead of repeating an identical message the
   *  operator may have muted/grouped. */
  private readonly lastSent = new Map<string, { at: number; count: number }>();

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

  /** Undo the optimistic lastSent write after a failed delivery so the next call retries. */
  private restore(id: string, last: { at: number; count: number } | undefined): void {
    if (last) this.lastSent.set(id, last);
    else this.lastSent.delete(id);
  }

  /** Bounded memory: per-EOA alert ids make the id space unbounded in a long-lived process —
   *  prune entries idle past the longest plausible cooldown once the map grows. */
  private prune(now: number): void {
    if (this.lastSent.size < 512) return;
    const horizon = 24 * 60 * 60 * 1000;
    for (const [id, v] of this.lastSent) {
      if (now - v.at > horizon) this.lastSent.delete(id);
    }
  }

  async send(id: string, message: string, opts?: { cooldownMs?: number; noEscalation?: boolean }): Promise<boolean> {
    const now = this.now();
    this.prune(now);
    const cooldown = opts?.cooldownMs ?? this.cooldownMs;
    const last = this.lastSent.get(id);
    if (last !== undefined && now - last.at < cooldown) return true; // within cooldown — handled
    const count = (last?.count ?? 0) + 1;
    // Record BEFORE awaiting so concurrent health cycles don't double-fire the same id.
    this.lastSent.set(id, { at: now, count });

    // A repeat of the same alert id means the condition PERSISTED across a full cooldown
    // window — escalate the wording so it reads as an ongoing incident, not a duplicate.
    // Routine periodic messages (heartbeats) opt out: they repeat BY DESIGN and an incident
    // prefix there would train the operator to ignore it where it matters.
    const text = !opts?.noEscalation && count >= 2 ? `⏰ STILL FIRING — reminder #${count}\n${message}` : message;

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    try {
      const res = await withTimeout(
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
        }),
        TELEGRAM_TIMEOUT_MS,
        "telegram.sendMessage",
      );
      if (!res.ok) {
        // Allow a retry next window if the send failed (don't hold the cooldown on failure).
        this.restore(id, last);
        const body = await res.text().catch(() => "");
        console.warn(`[Alert] Telegram send failed (${res.status}): ${body.slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (err) {
      this.restore(id, last);
      // redactError: a fetch/timeout error message embeds the request URL, which contains the
      // bot token (…/bot<TOKEN>/sendMessage). Never log it raw.
      console.warn(`[Alert] Telegram send error: ${redactError(err)}`);
      return false;
    }
  }
}

/** Build an Alerter from config: Telegram when both token + chatId are set, else a no-op.
 *  Loudly logs which one it built — a production deploy where the operator BELIEVES alerts
 *  are armed but the secrets are unset is the worst possible blind spot. */
export function createAlerter(
  config: { telegramBotToken: string | null; telegramChatId: string | null },
  opts?: { cooldownMs?: number; now?: () => number; quiet?: boolean },
): Alerter {
  if (config.telegramBotToken && config.telegramChatId) {
    if (!opts?.quiet) {
      console.log(`[Alert] Telegram alerting ENABLED (chat …${config.telegramChatId.slice(-4)})`);
    }
    return new TelegramAlerter({
      botToken: config.telegramBotToken,
      chatId: config.telegramChatId,
      cooldownMs: opts?.cooldownMs,
      now: opts?.now,
    });
  }
  if (!opts?.quiet) {
    console.warn(
      "[Alert] Telegram alerting DISABLED — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID. " +
        "Stuck-money / treasury / code-error conditions will NOT reach the operator.",
    );
  }
  return new NoopAlerter();
}
