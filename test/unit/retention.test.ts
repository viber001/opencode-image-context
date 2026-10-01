import { describe, expect, test } from "bun:test";
import { planRetention, type RetentionItem } from "../../src/core/retention.js";
import { DEFAULT_CONFIG, type VisionConfig } from "../../src/core/types.js";

function cfg(overrides: Partial<VisionConfig>): VisionConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function items(sizes: number[]): RetentionItem[] {
  return sizes.map((bytes, i) => ({ id: `img-${i}`, bytes }));
}

describe("planRetention", () => {
  test("does nothing at or below the high watermark", () => {
    const plan = planRetention(items([10, 10, 10]), cfg({ highWatermarkBytes: 100, lowWatermarkBytes: 50 }));
    expect(plan.evict).toEqual([]);
    expect(plan.kept).toEqual(["img-0", "img-1", "img-2"]);
    expect(plan.reason).toBe("below-high");
  });

  test("evicts the oldest in one batch down to the low watermark", () => {
    // 10 images x 10 bytes = 100 > high 60; low 30 => must drop 7 to reach 30.
    const plan = planRetention(
      items(new Array(10).fill(10)),
      cfg({ highWatermarkBytes: 60, lowWatermarkBytes: 30, evictionRatio: 0.66, keepRecentImages: 1 }),
    );
    expect(plan.evict.length).toBeGreaterThan(1); // batch, not single-image slide
    expect(plan.evict[0]).toBe("img-0"); // oldest first
    expect(plan.keptBytes).toBeLessThanOrEqual(30);
    expect(plan.kept).toEqual(plan.kept.toSorted((a, b) => Number(a.slice(4)) - Number(b.slice(4))));
    expect(plan.kept.at(-1)).toBe("img-9"); // newest kept
  });

  test("never evicts into the keep-recent floor", () => {
    const plan = planRetention(
      items(new Array(5).fill(100)),
      cfg({ highWatermarkBytes: 100, lowWatermarkBytes: 10, evictionRatio: 1, keepRecentImages: 4 }),
    );
    expect(plan.evict).toEqual(["img-0"]);
    expect(plan.kept).toHaveLength(4);
  });

  test("caps a single batch at evictionRatio", () => {
    const plan = planRetention(
      items(new Array(100).fill(10)),
      cfg({ highWatermarkBytes: 100, lowWatermarkBytes: 1, evictionRatio: 0.5, keepRecentImages: 0 }),
    );
    expect(plan.evict.length).toBe(50);
  });

  test("keptBytes accounting is consistent", () => {
    const plan = planRetention(items([7, 13, 29, 3]), cfg({ highWatermarkBytes: 40, lowWatermarkBytes: 15 }));
    expect(plan.totalBytes).toBe(52);
    expect(plan.keptBytes + plan.evictedBytes).toBe(plan.totalBytes);
  });
});
