import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/core/memoryStore.js";
import { createRuntime } from "../../src/core/runtime.js";
import type { VisionTransport } from "../../src/ports.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "vic-mem-"));
}

describe("MemoryStore", () => {
  test("writes json + markdown and never contains base64", () => {
    const dir = tmp();
    const m = new MemoryStore(dir);
    m.upsertImage("m1", { sha256: "a".repeat(64), mime: "image/png", bytes: 100, filename: "x.png" });
    m.setAnalysis("m1", "a".repeat(64), "A yellow map.");
    m.addQA("m1", "color?", "yellow");
    expect(existsSync(join(dir, "vision-memory", "m1.json"))).toBe(true);
    const md = readFileSync(join(dir, "vision-memory", "m1.md"), "utf8");
    expect(md).toContain("A yellow map.");
    expect(md).toContain("Q: color?");
    expect(md).not.toContain("base64");
  });

  test("reloads existing memory", () => {
    const dir = tmp();
    new MemoryStore(dir).upsertImage("m1", { sha256: "b".repeat(64), mime: "image/png", bytes: 5 });
    expect(new MemoryStore(dir).get("m1", "b".repeat(64))?.bytes).toBe(5);
  });
});

describe("VisionManager dedup", () => {
  test("reuses a stored observation instead of re-uploading the same image", async () => {
    const sent: string[] = [];
    const transport: VisionTransport = {
      async createChild() {
        return "v1";
      },
      async sendImage(_c, image) {
        sent.push(image.url);
        return "observed once";
      },
      async ask() {
        return "";
      },
      async isAlive() {
        return true;
      },
    };
    const rt = createRuntime({ dataDir: tmp() }, transport);
    const a = rt.manager.ingest("m1", [{ type: "file", mime: "image/png", url: PNG_URL }]);
    await rt.manager.routeImages("m1", a.images);
    const b = rt.manager.ingest("m1", [{ type: "file", mime: "image/png", url: PNG_URL }]);
    const route = await rt.manager.routeImages("m1", b.images);
    expect(sent).toHaveLength(1); // uploaded once
    expect(route.text).toContain("observed once");
    expect(route.text).toContain("recalled from memory");
  });
});
