import { isImageAttachment, parseImageDataUrl } from "./image.js";
import { sha256Base64, shortHash } from "./hash.js";
import type { VisionConfig } from "./types.js";

/** Structural view of a V1 wire message; adapters map their real types onto this. */
export interface WirePart {
  type?: string;
  [key: string]: unknown;
}

export interface WireMessage {
  info?: { sessionID?: string; role?: string; type?: string };
  parts?: WirePart[];
}

export function omissionNote(mime: string, bytes: number, sha256: string): string {
  return `[image omitted: sha256=${shortHash(sha256, 16)} mime=${mime} bytes=${bytes} already analyzed]`;
}

/**
 * Remove image attachments from a single main-session message, in place.
 * Tool parts carry images in `state.attachments`; any image there is dropped and
 * a textual omission note appended to `state.output`.
 *
 * Returns the number of images removed.
 */
export function stripImagesFromMessage(msg: WireMessage): number {
  if (!msg || !Array.isArray(msg.parts)) return 0;
  let removed = 0;
  for (const part of msg.parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "tool") {
      const state = part.state as { attachments?: unknown[]; output?: unknown } | undefined;
      if (!state || !Array.isArray(state.attachments)) continue;
      const kept: unknown[] = [];
      const notes: string[] = [];
      for (const att of state.attachments) {
        if (isImageAttachment(att)) {
          const parsed = parseImageDataUrl(att.url);
          if (parsed) {
            notes.push(omissionNote(parsed.mime, parsed.bytes, sha256Base64(parsed.base64)));
            removed++;
            continue;
          }
        }
        kept.push(att);
      }
      if (removed > 0) {
        state.attachments = kept;
        if (notes.length > 0 && typeof state.output === "string" && !state.output.includes("[image omitted:")) {
          state.output = `${state.output}\n${notes.join("\n")}`.trim();
        }
      }
    } else if (part.type === "file" && isImageAttachment(part)) {
      // A stray file image part: keep the slot but make it textual (stays schema-valid).
      const parsed = parseImageDataUrl(String((part as { url?: unknown }).url ?? ""));
      if (parsed) {
        const mutable = part as Record<string, unknown>;
        mutable.type = "text";
        mutable.text = omissionNote(parsed.mime, parsed.bytes, sha256Base64(parsed.base64));
        delete mutable.url;
        delete mutable.mime;
        delete mutable.filename;
        removed++;
      }
    }
  }
  return removed;
}

/**
 * Strip images from every non-vision message. Vision-session messages are left
 * untouched so the child can actually see its images.
 */
export function stripMainImages(messages: readonly WireMessage[], isVision: (sid: string) => boolean): number {
  let removed = 0;
  for (const msg of messages) {
    const sid = msg?.info?.sessionID;
    if (typeof sid === "string" && isVision(sid)) continue;
    removed += stripImagesFromMessage(msg);
  }
  return removed;
}

/** Collect image attachments (oldest first) from vision-session messages. */
export function collectVisionImages(msg: WireMessage): Array<{ sha256: string; bytes: number; attach: (url: string) => void }> {
  const out: Array<{ sha256: string; bytes: number; attach: (url: string) => void }> = [];
  if (!msg || !Array.isArray(msg.parts)) return out;
  for (const part of msg.parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "tool") {
      const state = part.state as { attachments?: unknown[] } | undefined;
      for (const att of state?.attachments ?? []) {
        if (isImageAttachment(att)) {
          const parsed = parseImageDataUrl(att.url);
          if (parsed) {
            out.push({
              sha256: sha256Base64(parsed.base64),
              bytes: parsed.bytes,
              attach: (url: string) => {
                (att as { url: string }).url = url;
              },
            });
          }
        }
      }
    } else if (part.type === "file" && isImageAttachment(part)) {
      const parsed = parseImageDataUrl(part.url as string);
      if (parsed) {
        out.push({
          sha256: sha256Base64(parsed.base64),
          bytes: parsed.bytes,
          attach: (url: string) => {
            (part as { url: string }).url = url;
          },
        });
      }
    }
  }
  return out;
}

/** Count image attachments per session id across the messages. */
export function countImages(messages: readonly WireMessage[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const msg of messages) {
    const sid = msg?.info?.sessionID ?? "?";
    const n = collectVisionImages(msg).length;
    if (n > 0) out[sid] = (out[sid] ?? 0) + n;
  }
  return out;
}

export interface RetentionOutcome {
  total: number;
  evicted: number;
  kept: number;
  totalBytes: number;
  keptBytes: number;
}

/**
 * Apply the vision child's hysteretic batch eviction across its messages.
 * `plan` decides which hashes to drop; evicted images are replaced with a valid
 * 1x1 PNG so no illegal base64 ever reaches the provider.
 */
export function applyVisionRetention(
  messages: readonly WireMessage[],
  isVision: (sid: string) => boolean,
  plan: (items: Array<{ id: string; bytes: number }>) => { evict: string[] },
  placeholderUrl: string,
): RetentionOutcome {
  const items: Array<{ id: string; bytes: number; attach: (url: string) => void }> = [];
  for (const msg of messages) {
    const sid = msg?.info?.sessionID;
    if (typeof sid !== "string" || !isVision(sid)) continue;
    for (const item of collectVisionImages(msg)) {
      items.push({ id: `${item.sha256}:${items.length}`, bytes: item.bytes, attach: item.attach });
    }
  }
  if (items.length === 0) return { total: 0, evicted: 0, kept: 0, totalBytes: 0, keptBytes: 0 };
  const result = plan(items.map(({ id, bytes }) => ({ id, bytes })));
  const evictSet = new Set(result.evict);
  let evicted = 0;
  let evictedBytes = 0;
  let totalBytes = 0;
  for (const item of items) {
    totalBytes += item.bytes;
    if (evictSet.has(item.id)) {
      item.attach(placeholderUrl);
      evicted++;
      evictedBytes += item.bytes;
    }
  }
  return {
    total: items.length,
    evicted,
    kept: items.length - evicted,
    totalBytes,
    keptBytes: totalBytes - evictedBytes,
  };
}

export type { VisionConfig };
