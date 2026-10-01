import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/core/runtime.js";
import type { Attachment } from "../../src/core/types.js";
import type { VisionTransport } from "../../src/ports.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function attach(name: string, fill = "A"): Attachment {
  // Distinguish images by embedding a marker in the base64 payload (still valid base64).
  const marker = Buffer.from(name + fill).toString("base64");
  return { type: "file", mime: "image/png", url: `data:image/png;base64,${PNG_B64}${marker}` , filename: name };
}

class FaultyTransport implements VisionTransport {
  created: string[] = [];
  sends: Array<{ child: string; image: string }> = [];
  asks: Array<{ child: string; text: string }> = [];
  sendImageFails = 1; // fail the first N sendImage calls
  askFails = 1; // fail the first N ask calls
  private seq = 0;
  async createChild(): Promise<string> {
    const id = `child_${++this.seq}`;
    this.created.push(id);
    return id;
  }
  async sendImage(child: string, image: { url: string }): Promise<string> {
    this.sends.push({ child, image: image.url });
    if (this.sendImageFails-- > 0) throw new Error("vision child exploded");
    return `analysis ${this.sends.length}`;
  }
  async ask(child: string, text: string): Promise<string> {
    this.asks.push({ child, text });
    if (this.askFails-- > 0) throw new Error("vision child exploded");
    return `answer to: ${text}`;
  }
  async isAlive(): Promise<boolean> {
    return true;
  }
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "vic-rec-"));
}

describe("failure recovery", () => {
  test("sendImage failure replaces the child and retries on the fresh one", async () => {
    const t = new FaultyTransport();
    const rt = createRuntime({ dataDir: tmp(), debug: true }, t);
    const ing = rt.manager.ingest("m1", [attach("a.png")]);
    const route = await rt.manager.routeImages("m1", ing.images);
    expect(route.restarted).toBe(true);
    expect(route.text.startsWith("[vision subsystem restarted]")).toBe(true);
    expect(t.created).toHaveLength(2); // initial + replacement
    expect(route.visionSessionID).toBe("child_2");
    // first attempt on child_1 (failed), retry on the replacement child_2
    expect(t.sends.map((s) => s.child)).toEqual(["child_1", "child_2"]);
    expect(route.observations[0]!.text).toBe("analysis 2");
  });

  test("ask failure restarts and retries, restoring memory into the new child", async () => {
    const t = new FaultyTransport();
    t.sendImageFails = 0;
    const rt = createRuntime({ dataDir: tmp(), debug: true }, t);
    const ing = rt.manager.ingest("m1", [attach("a.png")]);
    await rt.manager.routeImages("m1", ing.images);
    const asyncIng = rt.manager.ingest("m1", [{ type: "file", mime: "image/png", url: `data:image/png;base64,${PNG_B64}${Buffer.from("b.png").toString("base64")}`, filename: "b.png" }]);
    await rt.manager.routeImages("m1", asyncIng.images);
    t.asks = [];
    const answer = await rt.manager.ask("m1", "does the map show a lake?");
    expect(answer.startsWith("[vision subsystem restarted]")).toBe(true);
    expect(t.created).toHaveLength(2); // initial + replacement
    const seed = t.asks.find((a) => a.text.startsWith("[vision memory restore]"));
    expect(seed).toBeDefined();
    expect(seed!.child).toBe("child_2");
  });

  test("a permanently broken child yields a text error, not a crash", async () => {
    const t = new FaultyTransport();
    t.sendImageFails = 99;
    const rt = createRuntime({ dataDir: tmp() }, t);
    const ing = rt.manager.ingest("m1", [attach("a.png")]);
    const route = await rt.manager.routeImages("m1", ing.images);
    expect(route.observations[0]!.text).toContain("vision error");
    expect(route.text).toContain("vision error: analysis unavailable");
  });
});
