/**
 * Chooses how many blocks to ask `eth_getLogs` for at a time.
 *
 * Providers refuse ranges that span too many blocks or return too many logs, and the limit moves
 * with log density, so it has to be discovered. The rules:
 *
 * - Start at `max`.
 * - On a refusal, use the provider's suggested size when it gave one and it is smaller, otherwise
 *   halve. Never below 1.
 * - After a range that was read without any refusal since the previous success, double again, up
 *   to the ceiling.
 * - Once a range is refused after an earlier read fitted, that read's size becomes the ceiling for
 *   the rest of the run, so the size does not keep alternating between a size that fits and a
 *   doubled one that is refused. (Credit: Blockwarden's monitor.)
 */
export class AdaptiveRangeSize {
  readonly max: number;
  #size: number;
  #ceiling: number;
  #lastSuccess: number | undefined;
  #refusedSinceSuccess = false;

  constructor(max: number, initial: number = max) {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError(`max must be a positive integer`);
    this.max = max;
    this.#ceiling = max;
    this.#size = Math.min(Math.max(1, Math.floor(initial)), max);
  }

  /** The number of blocks to request next. */
  get size(): number {
    return this.#size;
  }

  get ceiling(): number {
    return this.#ceiling;
  }

  succeeded(): void {
    this.#lastSuccess = this.#size;
    if (!this.#refusedSinceSuccess) {
      this.#size = Math.min(this.#size * 2, this.#ceiling);
    }
    this.#refusedSinceSuccess = false;
  }

  /**
   * Records a refusal of the current size. Returns false when the size is already 1, so it cannot
   * shrink and the caller must treat the refusal as an error rather than retry smaller.
   */
  refused(suggestedSize?: number): boolean {
    if (this.#size === 1) return false;
    this.#refusedSinceSuccess = true;
    if (this.#lastSuccess !== undefined && this.#size > this.#lastSuccess) {
      this.#ceiling = Math.min(this.#ceiling, this.#lastSuccess);
    }
    const halved = Math.floor(this.#size / 2);
    const suggested =
      suggestedSize !== undefined && Number.isFinite(suggestedSize) && suggestedSize >= 1
        ? Math.floor(suggestedSize)
        : undefined;
    this.#size = Math.max(1, suggested !== undefined && suggested < this.#size ? suggested : halved);
    return true;
  }
}
