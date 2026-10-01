import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Hash the decoded bytes of a raw base64 payload. */
export function sha256Base64(base64: string): string {
  return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
}

export function shortHash(hex: string, len = 12): string {
  return hex.slice(0, len);
}
