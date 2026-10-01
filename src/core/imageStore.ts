import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseImageDataUrl } from "./image.js";
import type { Attachment } from "./types.js";

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/**
 * Content-addressed on-disk store for original images. Files are named by
 * sha256 so the same image is never duplicated; the vision memory references
 * them by hash rather than embedding base64.
 */
export class ImageStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "images");
  }

  private ensure(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  pathFor(sha256: string, mime: string): string {
    const ext = EXT[mime] ?? "bin";
    return join(this.dir, `${sha256}.${ext}`);
  }

  has(sha256: string, mime: string): boolean {
    return existsSync(this.pathFor(sha256, mime));
  }

  /** Persist decoded image bytes; returns the stored path (idempotent). */
  save(sha256: string, img: Attachment): string | null {
    const parsed = parseImageDataUrl(img.url);
    if (!parsed) return null;
    const path = this.pathFor(sha256, parsed.mime);
    if (existsSync(path)) return path;
    this.ensure();
    writeFileSync(path, Buffer.from(parsed.base64, "base64"));
    return path;
  }

  read(sha256: string, mime: string): Buffer | null {
    const path = this.pathFor(sha256, mime);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }
}
