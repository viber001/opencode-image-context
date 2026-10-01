import { MINIMAL_PNG_DATA_URL, type Attachment, type ParsedImage } from "./types.js";

const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,(.*)$/s;

export function isDataUrl(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("data:");
}

export function isImageAttachment(att: unknown): att is Attachment {
  if (!att || typeof att !== "object") return false;
  const a = att as Record<string, unknown>;
  return typeof a.mime === "string" && a.mime.startsWith("image/") && typeof a.url === "string";
}

/**
 * Parse a `data:<mime>;base64,<payload>` URL. Returns null for anything that is
 * not a base64 image data URL (plain http(s) URLs and malformed values).
 */
export function parseImageDataUrl(url: string): ParsedImage | null {
  const m = DATA_URL_RE.exec(url);
  if (!m) return null;
  const mime = m[1] ?? "";
  const enc = m[2] ?? "";
  const payload = m[3] ?? "";
  if (enc !== ";base64") {
    // Non-base64 data URLs are not images we manage here.
    return null;
  }
  if (!mime.startsWith("image/")) return null;
  // Reject payloads with characters outside base64 to avoid feeding providers junk.
  if (payload.length > 0 && !/^[A-Za-z0-9+/=\s]+$/.test(payload)) return null;
  const clean = payload.replace(/\s+/g, "");
  const bytes = Math.floor((clean.length * 3) / 4);
  return { mime, base64: clean, bytes, dataUrl: url };
}

export function toDataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

export function minimalPngUrl(): string {
  return MINIMAL_PNG_DATA_URL;
}

/** Validate that a string is a well-formed base64 image data URL. */
export function isValidImageDataUrl(url: string): boolean {
  return parseImageDataUrl(url) !== null;
}
