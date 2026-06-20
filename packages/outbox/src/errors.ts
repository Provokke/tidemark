/** A delivery that will never succeed as it stands (a 4xx answer, a refused URL): it goes dead at once. */
export class PermanentDeliveryError extends Error {
  override name = "PermanentDeliveryError";
}
