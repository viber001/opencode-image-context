import { parseImageDataUrl } from "../core/image.js";
import { sha256Base64, shortHash } from "../core/hash.js";
import { omissionNote } from "../core/transform.js";

/**
 * V2 adapter's structural view of a model message. OpenCode V2 exposes the
 * pre-request model messages through `ctx.session.hook("context")`; each message
 * carries its content parts in `parts` (AI-SDK style). Images are `file` parts,
 * either at the top level or nested inside a `tool-result` part's
 * `result.value` array.
 */
export interface V2Part {
  type?: string;
  [key: string]: unknown;
}

export interface V2Message {
  role?: string;
  parts?: V2Part[];
  content?: V2Part[];
  [key: string]: unknown;
}

function partsOf(msg: V2Message): V2Part[] | undefined {
  if (Array.isArray(msg.parts)) return msg.parts;
  if (Array.isArray(msg.content)) return msg.content;
  return undefined;
}

/** Resolve the data URL of an image file part, if it is one. */
function imageUrlOf(part: V2Part): string | null {
  if (part.type !== "file") return null;
  const mime = typeof part.mime === "string" ? part.mime : typeof part.mediaType === "string" ? part.mediaType : "";
  const uri = typeof part.uri === "string" ? part.uri : typeof part.url === "string" ? part.url : undefined;
  if (uri && uri.startsWith("data:image/")) return uri;
  if (mime.startsWith("image/") && typeof part.data === "string") return `data:${mime};base64,${part.data}`;
  return null;
}

/** Every image file part inside one part list, including nested tool-result values. */
function imageParts(parts: V2Part[] | undefined): V2Part[] {
  const out: V2Part[] = [];
  if (!parts) return out;
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (imageUrlOf(part)) out.push(part);
    const result = part.result as { value?: V2Part[] } | undefined;
    if (Array.isArray(result?.value)) {
      for (const inner of result.value) {
        if (inner && typeof inner === "object" && imageUrlOf(inner)) out.push(inner);
      }
    }
  }
  return out;
}

export function collectV2Images(messages: readonly V2Message[]): Array<{
  sha256: string;
  bytes: number;
  attach: (url: string) => void;
}> {
  const out: Array<{ sha256: string; bytes: number; attach: (url: string) => void }> = [];
  for (const msg of messages) {
    for (const part of imageParts(partsOf(msg))) {
      const url = imageUrlOf(part);
      const parsed = url ? parseImageDataUrl(url) : null;
      if (!parsed) continue;
      out.push({
        sha256: sha256Base64(parsed.base64),
        bytes: parsed.bytes,
        attach: (replacement: string) => {
          part.uri = replacement;
          delete part.url;
          delete part.data;
        },
      });
    }
  }
  return out;
}

export function countV2Images(messages: readonly V2Message[]): number {
  let n = 0;
  for (const msg of messages) n += imageParts(partsOf(msg)).length;
  return n;
}

function toTextPlaceholder(part: V2Part, mime: string, bytes: number, sha256: string): void {
  const note = omissionNote(mime, bytes, sha256);
  // A stray file image part becomes a text part so it stays schema-valid.
  part.type = "text";
  part.text = note;
  delete part.uri;
  delete part.url;
  delete part.mime;
  delete part.mediaType;
  delete part.name;
  delete part.data;
}

/** Replace every image file part with a textual omission note (in place). */
export function stripV2Images(messages: readonly V2Message[]): number {
  let removed = 0;
  for (const msg of messages) {
    for (const part of imageParts(partsOf(msg))) {
      const url = imageUrlOf(part);
      const parsed = url ? parseImageDataUrl(url) : null;
      if (!parsed) continue;
      toTextPlaceholder(part, parsed.mime, parsed.bytes, sha256Base64(parsed.base64));
      removed++;
    }
  }
  return removed;
}

/**
 * Append observations produced by the vision child into the last tool-result
 * part, so the main model sees the analysis where it saw the image.
 */
export function injectObservations(messages: readonly V2Message[], observations: string[]): boolean {
  const text = observations.filter(Boolean).join("\n");
  if (!text) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const parts = partsOf(messages[i]!);
    if (!parts) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const result = parts[j]?.result as { value?: V2Part[] } | undefined;
      if (Array.isArray(result?.value)) {
        result.value.push({ type: "text", text });
        return true;
      }
    }
  }
  return false;
}

export interface V2RetentionOutcome {
  total: number;
  evicted: number;
  kept: number;
  totalBytes: number;
  keptBytes: number;
}

/**
 * Apply the vision child's hysteretic batch eviction across its own messages.
 * Evicted images are replaced with a valid minimal PNG so no illegal base64 is
 * ever sent to the provider.
 */
export function applyV2Retention(
  messages: readonly V2Message[],
  plan: (items: Array<{ id: string; bytes: number }>) => { evict: string[] },
  placeholderUrl: string,
): V2RetentionOutcome {
  const items: Array<{ id: string; bytes: number; attach: (url: string) => void }> = [];
  for (const img of collectV2Images(messages)) {
    items.push({ id: `${img.sha256}:${items.length}`, bytes: img.bytes, attach: img.attach });
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

export { shortHash };
