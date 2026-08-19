// Zero-cost guardrails around the AI agent: a circuit breaker so a struggling
// provider doesn't get hammered request after request, and a keyword-based
// frustration heuristic so upset customers get flagged without paying for an
// extra AI call just to detect sentiment.

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 60_000;

let consecutiveFailures = 0;
let circuitOpenUntil: number | null = null;

export const circuitBreaker = {
  isOpen(): boolean {
    if (circuitOpenUntil === null) return false;
    if (Date.now() < circuitOpenUntil) return true;
    // Cooldown elapsed - allow a half-open retry.
    circuitOpenUntil = null;
    consecutiveFailures = 0;
    return false;
  },
  recordSuccess(): void {
    consecutiveFailures = 0;
    circuitOpenUntil = null;
  },
  /** Returns true if this failure is the one that just tripped the breaker. */
  recordFailure(): boolean {
    consecutiveFailures++;
    if (consecutiveFailures >= FAILURE_THRESHOLD && circuitOpenUntil === null) {
      circuitOpenUntil = Date.now() + COOLDOWN_MS;
      return true;
    }
    return false;
  },
};

const STRONG_NEGATIVE_KEYWORDS = ['scam', 'worst', 'furious', 'unacceptable', 'rip off', 'rip-off', 'fraud'];
const NEGATIVE_KEYWORDS = ['terrible', 'angry', 'frustrated', 'frustrating', 'ridiculous', 'refund', 'cancel my', 'never again', 'disappointed', 'horrible', 'waste of time', 'not happy', 'unhappy'];
const POSITIVE_KEYWORDS = ['thank you', 'thanks', 'love', 'great', 'amazing', 'perfect', 'happy', 'appreciate', 'wonderful', 'excellent', 'awesome', 'beautiful', 'best'];

/**
 * Bidirectional keyword sentiment score. Originally built only to detect
 * frustration for escalations (so it only ever went negative) - extended to
 * also recognize positive language, since it's now reused for real sentiment
 * analytics where "always neutral or worse, never positive" would be misleading.
 */
export function scoreSentiment(text: string): { score: number; sentiment: string; confidence: number } {
  const lower = text.toLowerCase();
  let score = 0;
  let hits = 0;

  for (const kw of STRONG_NEGATIVE_KEYWORDS) {
    if (lower.includes(kw)) { score -= 0.4; hits++; }
  }
  for (const kw of NEGATIVE_KEYWORDS) {
    if (lower.includes(kw)) { score -= 0.2; hits++; }
  }
  for (const kw of POSITIVE_KEYWORDS) {
    if (lower.includes(kw)) { score += 0.3; hits++; }
  }

  const exclaims = (text.match(/!/g) || []).length;
  const letters = text.replace(/[^a-zA-Z]/g, '');
  const caps = text.replace(/[^A-Z]/g, '');
  const shouting = letters.length > 8 && caps.length / letters.length > 0.6;

  // Excessive punctuation/shouting reads as frustration only when paired with
  // an already-negative signal - "Thank you so much!!!" shouldn't be punished.
  if (score < 0) {
    if (exclaims >= 3) score -= 0.15;
    if (shouting) score -= 0.2;
  }

  score = Math.max(-1, Math.min(1, score));
  const sentiment = score <= -0.6 ? 'very_negative'
    : score < 0 ? 'negative'
    : score === 0 ? 'neutral'
    : score >= 0.6 ? 'very_positive'
    : 'positive';
  const confidence = hits > 0 ? 0.6 : 0.35;

  return { score, sentiment, confidence };
}

// Daily per-customer token budget, protects the shared free-tier quota from
// one runaway conversation (or loop bug) burning through the whole day's limit.
export const DAILY_TOKEN_CAP = 20000;

// The Groq account has its own account-wide daily token cap, shared across
// every customer on every channel. When it's hit, EVERY customer gets the
// fallback message until it resets - this is a total outage, not a
// per-customer issue, and it can stay tripped for 30+ minutes. Without a
// cooldown here, every single incoming message during that window would
// create its own escalation row and admin notification, flooding the
// dashboard with duplicates of the same root cause.
const OUTAGE_NOTIFY_COOLDOWN_MS = 10 * 60_000;
let lastOutageNotifyAt: number | null = null;

/** True at most once per cooldown window - call before raising an outage-level alert. */
export function shouldNotifyOutage(): boolean {
  const now = Date.now();
  if (lastOutageNotifyAt !== null && now - lastOutageNotifyAt < OUTAGE_NOTIFY_COOLDOWN_MS) {
    return false;
  }
  lastOutageNotifyAt = now;
  return true;
}

/** Detects the specific "whole Groq account is out of daily tokens" error shape. */
export function isProviderRateLimitError(error: any): boolean {
  return error?.status === 429 || error?.code === 'rate_limit_exceeded' || error?.error?.code === 'rate_limit_exceeded';
}

export const FALLBACK_MESSAGE =
  "Sorry for the delay! We're experiencing high demand right now — one of our team members will follow up with you shortly.";
