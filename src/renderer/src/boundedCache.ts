/**
 * A Map that forgets its oldest entry once it is full.
 *
 * The renderer's frame caches hold base64 data URLs — a 10 KB JPEG costs about
 * 27 KB resident as a UTF-16 string — and their keys embed a clip's trimmed
 * range, so every drag of a handle mints a fresh entry and strands the old
 * one. Browsing a few hundred clips across twenty angles was hundreds of
 * megabytes that never came back.
 *
 * Insertion-ordered eviction rather than true LRU: `Map` gives that for free,
 * a miss costs one IPC call to a main process that already caches the same
 * frames on disk, and a cache of this kind is read in bursts of the thing you
 * are looking at anyway.
 */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, V>()

  constructor(private readonly maxEntries: number) {}

  get(key: K): V | undefined {
    return this.entries.get(key)
  }

  has(key: K): boolean {
    return this.entries.has(key)
  }

  set(key: K, value: V): void {
    // Re-inserting moves it to the back, so something being used repeatedly
    // is not evicted just because it was first through the door.
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  get size(): number {
    return this.entries.size
  }
}
