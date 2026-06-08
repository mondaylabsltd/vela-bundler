/**
 * Promise timeout utility.
 */

/** Default timeout for individual RPC calls. */
export const RPC_TIMEOUT_MS = 5_000;

/**
 * Race a promise against a timeout. Returns the result or throws on timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "operation",
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
