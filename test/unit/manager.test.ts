import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/core/runtime.js";
import { VisionPluginV1 } from "../../src/v1/plugin.js";
import type { VisionTransport } from "../../src/ports.js";
import type { Attachment } from "../../src/core/types.js";

function fakeTransport(): VisionTransport & { sent: Array<{ child: string; url: string; question: string }>; asked: string[]; alive: boolean } {
  const state = {
    sent: [] as Array<{ child: string; url: string; question: string }>,
    asked: [] as string[],
    alive: true,
    async createChild(): Promise<string> {
      return "vision-1";
    },
    async sendImage(child: string, image: Attachment, question: string): Promise<string> {
      state.sent.push({ child, url: image.url, question });
      return "A one-pixel opaque image.";
    },
    async ask(_child: string, question: string): Promise<string> {
      state.asked.push(question);
      return "Compared.";
    },
    async isAlive(): Promise<boolean> {
      return state.alive;
    },
  };
  return state;
}

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "vic-mgr-"));
}

describe("VisionManager.ingest", () => {
  test("hashes, stores and builds a placeholder", () => {
    const rt = createRuntime({ dataDir: tmp() });
    const res = rt.manager.ingest("m1", [{ type: "file", mime: "image/png", url: PNG_URL }]);
    expect(res.images).toHaveLength(1);
    expect(res.images[0]!.sha256).toHaveLength(64);
    expect(res.placeholder).toContain("[vision]");
    expect(res.placeholder).toContain("sha256:");
    expect(existsSync(join(rt.cfg.dataDir, "images"))).toBe(true);
    expect(readdirSync(join(rt.cfg.dataDir, "images")).length).toBe(1);
  });

  test("deduplicates identical images within one batch", () => {
    const rt = createRuntime({ dataDir: tmp() });
    const att = { type: "file", mime: "image/png", url: PNG_URL };
    const res = rt.manager.ingest("m1", [att, { ...att }]);
    expect(res.images).toHaveLength(1);
  });

  test("skips images over maxImageBytes but still reports them", () => {
    const rt = createRuntime({ dataDir: tmp(), maxImageBytes: 10 });
    const res = rt.manager.ingest("m1", [{ type: "file", mime: "image/png", url: PNG_URL }]);
    expect(res.images).toHaveLength(0);
    expect(res.skipped[0]?.reason).toBe("too-large");
    expect(res.placeholder).toContain("too-large");
  });
});

describe("VisionManager routing", () => {
  test("creates a persistent child, routes the image and records the observation", async () => {
    const dir = tmp();
    const transport = fakeTransport();
    const rt = createRuntime({ dataDir: dir }, transport);
    const res = rt.manager.ingest("m1", [{ type: "file", mime: "image/png", url: PNG_URL }]);
    const route = await rt.manager.routeImages("m1", res.images);
    expect(route.visionSessionID).toBe("vision-1");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.url).toBe(PNG_URL);
    expect(route.text).toContain("A one-pixel opaque image.");
    expect(route.observations[0]!.sha256).toBe(res.images[0]!.sha256);

    // persisted link + classification
    expect(rt.registry.getLink("m1")?.visionSessionID).toBe("vision-1");
    expect(rt.manager.classify("vision-1")).toBe("vision");
    expect(rt.manager.classify("m1")).toBe("main");

    // a second route reuses the same child
    const res2 = rt.manager.ingest("m1", [{ type: "file", mime: "image/png", url: PNG_URL.replace("iVBOR", "iVBOS") }]);
    const route2 = await rt.manager.routeImages("m1", res2.images);
    expect(route2.visionSessionID).toBe("vision-1");
  });

  test("ask forwards to the linked child", async () => {
    const transport = fakeTransport();
    const rt = createRuntime({ dataDir: tmp() }, transport);
    await rt.manager.ensureVisionChild("m1");
    const answer = await rt.manager.ask("m1", "compare");
    expect(answer).toBe("Compared.");
    expect(transport.asked).toEqual(["compare"]);
  });
});

describe("V1 adapter", () => {
  test("strips image attachments and appends a placeholder", async () => {
    const dir = tmp();
    const hooks = await VisionPluginV1(undefined, { dataDir: dir });
    const output = {
      title: "read",
      output: "Image read successfully",
      metadata: {},
      attachments: [
        { type: "file", mime: "image/png", url: PNG_URL },
        { type: "file", mime: "text/plain", url: "data:text/plain;base64,aGk=" },
      ],
    };
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "m1", callID: "c1" }, output);
    expect(output.attachments).toHaveLength(1);
    expect((output.attachments[0] as { mime: string }).mime).toBe("text/plain");
    expect(output.output).toContain("[vision]");
    expect(output.output).not.toContain("base64,");
  });

  test("does nothing when disabled", async () => {
    const hooks = await VisionPluginV1(undefined, { enabled: false, dataDir: tmp() });
    expect(hooks["tool.execute.after"]).toBeUndefined();
  });
});
