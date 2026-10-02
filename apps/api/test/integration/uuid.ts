export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Unix ms encoded in the first 48 bits of a UUIDv7. */
export function uuidV7Millis(id: string): number {
  return parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}
