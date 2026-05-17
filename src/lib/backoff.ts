// Exponential backoff with full jitter. Used by the outbox worker to compute
// `next_retry_at` after a delivery failure.
//
//   delay = min(MAX, BASE * factor ** attempt)
//   jittered = delay ± JITTER_RATIO * delay   (uniform random in that band)

export interface BackoffConfig {
  baseMs: number;
  factor: number;
  maxMs: number;
  jitterRatio: number; // 0.2 => ±20%
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 1_000,
  factor: 2,
  maxMs: 5 * 60 * 1_000,
  jitterRatio: 0.2,
};

export function nextDelayMs(
  attempts: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  // attempts is the number of times we have ALREADY tried (post-claim bump).
  // First failure: attempts == 1, first retry should be ~base.
  const power = Math.max(0, attempts - 1);
  const raw = Math.min(config.maxMs, config.baseMs * Math.pow(config.factor, power));
  const band = raw * config.jitterRatio;
  const offset = (random() * 2 - 1) * band;
  return Math.max(0, Math.round(raw + offset));
}

export function nextRetryAt(
  attempts: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  now: () => Date = () => new Date(),
  random: () => number = Math.random,
): Date {
  return new Date(now().getTime() + nextDelayMs(attempts, config, random));
}
