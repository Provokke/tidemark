import type { RpcTrace } from "./types.js";

const key = (address: readonly number[]) => address.join(".");

/**
 * The calls among `candidates` whose effects stand: plain calls (not delegate or static calls)
 * that neither failed themselves nor sit under a frame that failed. `tree` must hold every trace
 * of each candidate's transaction, so ancestors can be checked.
 */
export function effectiveCalls(candidates: readonly RpcTrace[], tree: readonly RpcTrace[]): RpcTrace[] {
  const failed = new Map<string, Set<string>>();
  for (const t of tree) {
    if (t.error === null) continue;
    const set = failed.get(t.transactionHash) ?? new Set<string>();
    set.add(key(t.traceAddress));
    failed.set(t.transactionHash, set);
  }
  return candidates.filter((t) => {
    if (t.type !== "call" || t.callType !== "call" || t.error !== null) return false;
    const errors = failed.get(t.transactionHash);
    if (errors === undefined) return true;
    for (let depth = 0; depth < t.traceAddress.length; depth++) {
      if (errors.has(key(t.traceAddress.slice(0, depth)))) return false;
    }
    return true;
  });
}
