// Resilience helpers: model fallback on unsupported-model errors,
// exponential-backoff retry on transient errors.
//
// Keep this module small and standalone. Used by executeTaskRun /
// executeReviewRun in codex-companion.mjs.

/**
 * Ordered fallback chains. When the primary model returns an
 * "unsupported model" error (typically because the auth tier
 * lacks access), we retry with the next entry in the chain.
 *
 * Chains are deliberately short (1-2 hops) to bound cost on
 * transient misconfiguration. Add entries only with evidence.
 */
export const MODEL_FALLBACK_CHAINS = {
  "gpt-5.4": ["gpt-5.3-codex"],
  "gpt-5.4-mini": ["gpt-5.3-codex"],
  "gpt-5.4-pro": ["gpt-5.4", "gpt-5.3-codex"],
  "gpt-5.3-codex-spark": ["gpt-5.3-codex"]
};

/**
 * Error classifier: the user's auth tier does not have access
 * to the requested model. Fallback-to-different-model is the
 * correct response.
 */
export function isModelUnavailableError(error) {
  if (!error) return false;
  const msg = String(error.message ?? error);
  return (
    /model\s+is\s+not\s+supported/i.test(msg) ||
    /model\s+not\s+available/i.test(msg) ||
    /unknown\s+model/i.test(msg) ||
    /not\s+authorized\s+for\s+model/i.test(msg)
  );
}

/**
 * Error classifier: transient failure. We retry these with exponential
 * backoff while preserving the original model. The classifier spans:
 *
 *   - Unix socket errors: ECONNRESET, ETIMEDOUT, EPIPE, "socket hang up"
 *   - HTTP 5xx server errors (500-599) surfaced in error messages
 *   - Explicit timeouts in error text
 *   - Generic "network error" phrases from various Node network APIs
 *
 * This list is intentionally broader than the narrowest "pure network
 * fault" definition because Codex's app-server sometimes surfaces 5xx
 * and timeout conditions as plain Error objects without normalized
 * codes. False-positive retries are cheap; false-negative surfacing of
 * transient errors is not.
 */
export function isTransientError(error) {
  if (!error) return false;
  const code = error.code ?? error.errno ?? "";
  const msg = String(error.message ?? error);
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE") return true;
  if (/\b5\d\d\b/.test(msg)) return true; // 500-599
  if (/timeout/i.test(msg)) return true;
  if (/socket hang up/i.test(msg)) return true;
  if (/network/i.test(msg) && /error/i.test(msg)) return true;
  return false;
}

/**
 * Sleep helper.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `fn`. If it throws a transient error, retry with
 * exponential backoff. Model-unavailable errors are NOT retried
 * here — the model-fallback layer handles those.
 *
 * Options:
 *   maxAttempts (default 3): including the first try.
 *   baseDelayMs (default 1000): delay before first retry.
 *   factor (default 2): multiplier per retry.
 *   onRetry(attempt, error, nextDelay): optional observer.
 */
export async function withTransientRetries(fn, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const factor = options.factor ?? 2;
  const onRetry = options.onRetry;

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      const delay = baseDelayMs * Math.pow(factor, attempt);
      if (onRetry) onRetry(attempt + 1, error, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Execute `fn(modelOverride)`. On model-unavailable errors,
 * retry with the next model in the fallback chain.
 *
 * `fn` is invoked with the model slug to use on each attempt.
 * On the first attempt `fn(originalModel)` is called; on fallback
 * attempts `fn(fallbackModel)` is called.
 *
 * Returns `{ result, usedModel, fellBackFrom }`:
 *   result: whatever `fn` returned
 *   usedModel: the model that finally succeeded
 *   fellBackFrom: originalModel if a fallback was used, else null
 *
 * Throws the last error if all chain entries are exhausted, or
 * if `originalModel` is not in MODEL_FALLBACK_CHAINS and throws.
 */
export async function withModelFallback(originalModel, fn, options = {}) {
  const onFallback = options.onFallback;

  // When the caller didn't specify a model (null/undefined), the Codex
  // CLI picks its default. We can't reliably supply a fallback for an
  // unknown original, so we pass through without a chain. This also
  // prevents prototype-pollution via `MODEL_FALLBACK_CHAINS[undefined]`.
  let chain;
  if (originalModel == null) {
    chain = [originalModel];
  } else if (Object.hasOwn(MODEL_FALLBACK_CHAINS, originalModel)) {
    chain = [originalModel, ...MODEL_FALLBACK_CHAINS[originalModel]];
  } else {
    chain = [originalModel];
  }

  let lastError;
  for (let i = 0; i < chain.length; i++) {
    const tryModel = chain[i];
    try {
      const result = await fn(tryModel);
      return {
        result,
        usedModel: tryModel,
        fellBackFrom: i === 0 ? null : originalModel
      };
    } catch (error) {
      lastError = error;
      if (!isModelUnavailableError(error) || i === chain.length - 1) {
        throw error;
      }
      if (onFallback) onFallback(tryModel, chain[i + 1], error);
    }
  }
  throw lastError;
}

/**
 * Compose both resilience layers. Model-fallback wraps transient-retry:
 * each attempt inside a model-hop gets its own transient-retry budget.
 */
export async function withResilience(originalModel, fn, options = {}) {
  return withModelFallback(
    originalModel,
    (currentModel) =>
      withTransientRetries(() => fn(currentModel), options.transient),
    { onFallback: options.onFallback }
  );
}
