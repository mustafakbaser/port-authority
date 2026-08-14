import { CancelledError } from '../errors.js';

/**
 * Runs `worker` over `items` with a bounded number of in-flight operations.
 *
 * The `/proc` walk touches thousands of files; issuing them all at once starves
 * libuv's thread pool and makes every other extension's file I/O wait behind it.
 *
 * `stopWhen` lets a caller abandon the remaining work early — the inode lookup is
 * complete as soon as every listening socket has found its process.
 */
export async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  options: { signal?: AbortSignal; stopWhen?: () => boolean } = {},
): Promise<void> {
  const size = Math.max(1, Math.floor(limit));
  let index = 0;
  let stopped = false;

  const runNext = async (): Promise<void> => {
    for (;;) {
      if (stopped || index >= items.length) {
        return;
      }
      if (options.signal?.aborted) {
        throw new CancelledError();
      }
      if (options.stopWhen?.()) {
        stopped = true;
        return;
      }
      const item = items[index];
      index += 1;
      await worker(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(size, items.length) }, runNext));
}
