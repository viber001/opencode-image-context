import { isImageAttachment, parseImageDataUrl } from "./image.js";
import { sha256Base64, shortHash } from "./hash.js";
import type { Logger } from "./logger.js";
import type { ImageStore } from "./imageStore.js";
import type { Registry } from "./registry.js";
import type { Attachment, ImageRecord, ParsedImage, VisionConfig } from "./types.js";

export interface IngestedImage {
  attachment: Attachment;
  parsed: ParsedImage;
  sha256: string;
  storedPath: string | null;
  record: ImageRecord;
}

export interface SkippedImage {
  mime: string;
  bytes: number;
  reason: "too-large" | "unparseable";
}

export interface IngestResult {
  images: IngestedImage[];
  skipped: SkippedImage[];
  /** Text that replaces the raw attachment in the main session. */
  placeholder: string;
}

export interface ManagerDeps {
  cfg: VisionConfig;
  registry: Registry;
  images: ImageStore;
  logger: Logger;
  now?: () => number;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function buildPlaceholder(images: IngestedImage[], skipped: SkippedImage[]): string {
  const lines: string[] = [];
  if (images.length > 0) {
    lines.push(
      `[vision] ${images.length} image(s) routed to the persistent vision session (kept out of this session's context):`,
    );
    for (const img of images) {
      lines.push(`  - ${img.parsed.mime} sha256:${shortHash(img.sha256)} ${humanBytes(img.parsed.bytes)}`);
    }
    lines.push("Use the vision.ask tool to query the vision session about these images.");
  }
  for (const s of skipped) {
    lines.push(`[vision] skipped ${s.mime} (${humanBytes(s.bytes)}): ${s.reason}`);
  }
  return lines.join("\n");
}

/**
 * Core entry point for the main-session path. `ingest` validates, hashes and
 * persists read image attachments, and returns the placeholder text that should
 * take their place in the main session. Adapters perform the actual mutation.
 */
export class VisionManager {
  private readonly deps: ManagerDeps;
  private readonly now: () => number;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  ingest(mainSessionID: string, attachments: readonly unknown[]): IngestResult {
    const { cfg, images, logger } = this.deps;
    const ingested: IngestedImage[] = [];
    const skipped: SkippedImage[] = [];
    const seen = new Set<string>();
    const now = this.now();

    for (const att of attachments) {
      if (!isImageAttachment(att)) continue;
      const parsed = parseImageDataUrl(att.url);
      if (!parsed) {
        skipped.push({ mime: att.mime || "?", bytes: 0, reason: "unparseable" });
        continue;
      }
      if (parsed.bytes > cfg.maxImageBytes) {
        logger.warn(
          `skipped image ${parsed.mime} ${humanBytes(parsed.bytes)} > maxImageBytes ${humanBytes(cfg.maxImageBytes)}`,
        );
        skipped.push({ mime: parsed.mime, bytes: parsed.bytes, reason: "too-large" });
        continue;
      }
      const sha256 = sha256Base64(parsed.base64);
      if (seen.has(sha256)) continue;
      seen.add(sha256);
      const storedPath = images.save(sha256, att);
      const record: ImageRecord = {
        sha256,
        mime: parsed.mime,
        bytes: parsed.bytes,
        filename: att.filename,
        firstSeen: now,
        lastSeen: now,
        mainSessionID,
        visionSessionID: "",
      };
      ingested.push({ attachment: att, parsed, sha256, storedPath, record });
      logger.debug(
        `ingested image sha256:${shortHash(sha256)} mime=${parsed.mime} bytes=${parsed.bytes} main=${mainSessionID}`,
      );
    }

    return { images: ingested, skipped, placeholder: buildPlaceholder(ingested, skipped) };
  }
}
