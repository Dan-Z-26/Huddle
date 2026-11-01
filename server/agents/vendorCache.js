const MAX_CACHE = 100;

/**
 * Keeps a result for next time, dropping the oldest once the cache is full.
 * @param {Map} store The cache.
 * @param {string} key The result's key.
 * @param {object} value The result.
 * @param {boolean} [cacheable] False for a fallback answer, which a real one should replace.
 * @returns {object} A copy of the value, so the caller can't change what is cached.
 */
export function remember(store, key, value, cacheable = true) {
  if (cacheable) store.set(key, value);
  if (cacheable && store.size > MAX_CACHE) store.delete(store.keys().next().value);
  return structuredClone(value);
}
