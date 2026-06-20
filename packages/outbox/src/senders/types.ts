import type { OutboxDelivery } from "@tidemark/engine";

/** Delivers messages to one destination. Throw to retry later; `PermanentDeliveryError` to give up. */
export interface Sender {
  send(delivery: OutboxDelivery): Promise<void>;
  close?(): Promise<void>;
}

/** Retry on 408, 425, 429 and 5xx; anything else that is not 2xx will not get better by itself. */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
