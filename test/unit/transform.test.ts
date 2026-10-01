import { describe, expect, test } from "bun:test";
import {
  stripImagesFromMessage,
  stripMainImages,
  applyVisionRetention,
  type WireMessage,
} from "../../src/core/transform.js";
import { MINIMAL_PNG_DATA_URL } from "../../src/core/types.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

function toolMessage(sessionID: string, urls: string[]): WireMessage {
  return {
    info: { sessionID, role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "read",
        callID: "c1",
        state: {
          status: "completed",
          output: "Image read successfully",
          attachments: urls.map((url, i) => ({ type: "file", mime: "image/png", url, id: `a${i}` })),
        },
      },
    ],
  };
}

function fileMessage(sessionID: string, urls: string[]): WireMessage {
  return {
    info: { sessionID, role: "user" },
    parts: urls.map((url) => ({ type: "file", mime: "image/png", url })),
  };
}

describe("stripImagesFromMessage", () => {
  test("removes tool-state image attachments and appends an omission note", () => {
    const msg = toolMessage("main", [PNG_URL]);
    expect(stripImagesFromMessage(msg)).toBe(1);
    const state = (msg.parts![0] as any).state;
    expect(state.attachments).toHaveLength(0);
    expect(state.output).toContain("[image omitted:");
  });

  test("keeps non-image attachments", () => {
    const msg: WireMessage = {
      info: { sessionID: "main" },
      parts: [
        {
          type: "tool",
          tool: "read",
          state: {
            output: "ok",
            attachments: [
              { type: "file", mime: "image/png", url: PNG_URL },
              { type: "file", mime: "text/plain", url: "data:text/plain;base64,aGk=" },
            ],
          },
        },
      ],
    };
    expect(stripImagesFromMessage(msg)).toBe(1);
    expect((msg.parts![0] as any).state.attachments).toHaveLength(1);
  });

  test("converts a stray file image part into a text part", () => {
    const msg = fileMessage("main", [PNG_URL]);
    expect(stripImagesFromMessage(msg)).toBe(1);
    expect(msg.parts![0]!.type).toBe("text");
    expect(String(msg.parts![0]!.text)).toContain("image omitted");
    expect((msg.parts![0] as any).url).toBeUndefined();
  });
});

describe("stripMainImages", () => {
  test("skips vision-session messages", () => {
    const main = toolMessage("main", [PNG_URL]);
    const vision = fileMessage("vision-1", [PNG_URL]);
    const removed = stripMainImages([main, vision], (sid) => sid === "vision-1");
    expect(removed).toBe(1);
    expect((vision.parts![0] as any).url).toBe(PNG_URL); // untouched
  });
});

describe("applyVisionRetention", () => {
  test("evicts the oldest images and replaces them with a valid placeholder", () => {
    const msgs: WireMessage[] = [1, 2, 3, 4].map((n) => fileMessage("vision-1", [`data:image/png;base64,${PNG_B64}${"A".repeat(n * 4)}`]));
    const plan = (items: Array<{ id: string }>) => ({ evict: items.slice(0, 3).map((i) => i.id) });
    const out = applyVisionRetention(msgs, (sid) => sid === "vision-1", plan, MINIMAL_PNG_DATA_URL);
    expect(out.total).toBe(4);
    expect(out.evicted).toBe(3);
    expect(out.kept).toBe(1);
    const remaining = msgs
      .flatMap((m) => m.parts ?? [])
      .map((p) => (p as any).url);
    expect(remaining.filter((u) => u === MINIMAL_PNG_DATA_URL)).toHaveLength(3);
    expect(remaining.filter((u) => u !== MINIMAL_PNG_DATA_URL)).toHaveLength(1);
  });

  test("no-op when there are no vision images", () => {
    const out = applyVisionRetention([toolMessage("main", [])], () => false, () => ({ evict: [] }), MINIMAL_PNG_DATA_URL);
    expect(out.total).toBe(0);
  });
});
