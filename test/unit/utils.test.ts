import { describe, expect, test } from "bun:test";
import { parseImageDataUrl, isImageAttachment, isValidImageDataUrl } from "../../src/core/image.js";
import { sha256Base64, sha256Hex } from "../../src/core/hash.js";
import { resolveConfig } from "../../src/core/config.js";
import { DEFAULT_CONFIG, MINIMAL_PNG_DATA_URL } from "../../src/core/types.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

describe("parseImageDataUrl", () => {
  test("parses a png data url", () => {
    const p = parseImageDataUrl(PNG_URL);
    expect(p).not.toBeNull();
    expect(p!.mime).toBe("image/png");
    expect(p!.base64).toBe(PNG_B64);
    expect(p!.bytes).toBeGreaterThan(0);
  });

  test("rejects non-image, http and malformed urls", () => {
    expect(parseImageDataUrl("data:text/plain;base64,aGk=")).toBeNull();
    expect(parseImageDataUrl("https://example.com/a.png")).toBeNull();
    expect(parseImageDataUrl("data:image/png,notbase64")).toBeNull();
    expect(parseImageDataUrl("")).toBeNull();
  });

  test("minimal png constant is valid", () => {
    expect(isValidImageDataUrl(MINIMAL_PNG_DATA_URL)).toBe(true);
  });
});

describe("isImageAttachment", () => {
  test("accepts file image attachments only", () => {
    expect(isImageAttachment({ type: "file", mime: "image/png", url: PNG_URL })).toBe(true);
    expect(isImageAttachment({ type: "file", mime: "text/plain", url: "data:text/plain;base64,aGk=" })).toBe(false);
    expect(isImageAttachment({ mime: "image/png" })).toBe(false);
    expect(isImageAttachment(null)).toBe(false);
  });
});

describe("hash", () => {
  test("base64 hash equals hash of decoded bytes", () => {
    expect(sha256Base64(PNG_B64)).toBe(sha256Hex(Buffer.from(PNG_B64, "base64")));
  });
});

describe("resolveConfig", () => {
  test("defaults when empty", () => {
    const c = resolveConfig(undefined);
    expect(c.enabled).toBe(true);
    expect(c.highWatermarkBytes).toBe(DEFAULT_CONFIG.highWatermarkBytes);
    expect(c.dataDir.length).toBeGreaterThan(0);
  });

  test("accepts a {vision:{}} wrapper and flat options", () => {
    expect(resolveConfig({ vision: { keepRecentImages: 3 } }).keepRecentImages).toBe(3);
    expect(resolveConfig({ keepRecentImages: 4 }).keepRecentImages).toBe(4);
  });

  test("repairs a low watermark that is not below the high one", () => {
    const c = resolveConfig({ highWatermarkBytes: 100, lowWatermarkBytes: 100 });
    expect(c.lowWatermarkBytes).toBeLessThan(c.highWatermarkBytes);
  });
});
