import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../src/core/registry.js";
import { ImageStore } from "../../src/core/imageStore.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "vic-test-"));
}

describe("Registry", () => {
  test("links a main session to a vision session and persists across reloads", () => {
    const dir = tmp();
    const reg = new Registry(dir);
    reg.setLink({ mainSessionID: "m1", visionSessionID: "v1", createdAt: 1, generation: 0 });
    expect(reg.getLink("m1")?.visionSessionID).toBe("v1");
    expect(reg.isVisionSession("v1")).toBe(true);
    expect(reg.isVisionSession("m1")).toBe(false);
    expect(reg.visionSessionOwner("v1")).toBe("m1");

    const reg2 = new Registry(dir);
    expect(reg2.getLink("m1")?.visionSessionID).toBe("v1");
    expect(reg2.isVisionSession("v1")).toBe(true);
  });

  test("replaceVision bumps the generation and reclassifies sessions", () => {
    const dir = tmp();
    const reg = new Registry(dir);
    reg.setLink({ mainSessionID: "m1", visionSessionID: "v1", createdAt: 1, generation: 0 });
    const link = reg.replaceVision("m1", "v2", 2);
    expect(link.generation).toBe(1);
    expect(reg.getLink("m1")?.visionSessionID).toBe("v2");
    expect(reg.isVisionSession("v2")).toBe(true);
  });
});

describe("ImageStore", () => {
  test("stores by hash and is idempotent", () => {
    const dir = tmp();
    const store = new ImageStore(dir);
    const att = { type: "file" as const, mime: "image/png", url: PNG_URL };
    const p1 = store.save("abc123", att);
    expect(p1).not.toBeNull();
    expect(store.has("abc123", "image/png")).toBe(true);
    const p2 = store.save("abc123", att);
    expect(p2).toBe(p1);
    expect(store.read("abc123", "image/png")?.toString("base64")).toBe(PNG_B64);
  });
});
