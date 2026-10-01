import type { VisionConfig } from "./types.js";

export interface RetentionItem {
  id: string;
  bytes: number;
}

export interface RetentionPlan {
  /** Ids to evict, oldest first. */
  evict: string[];
  kept: string[];
  totalBytes: number;
  evictedBytes: number;
  keptBytes: number;
  reason: "below-high" | "evicted" | "keep-recent-floor";
}

/**
 * Hysteretic batch eviction for the vision child's image history.
 *
 * The list is expected oldest-first. When the total payload is at or below the
 * high watermark nothing is evicted. When it exceeds the high watermark a
 * single batch of the oldest images is dropped — enough to fall to or below the
 * low watermark, bounded by `evictionRatio` and `keepRecentImages`.
 *
 * This is deliberately NOT an every-turn single-image slide: moving the window
 * each turn invalidates the provider prefix cache from the divergence point on.
 */
export function planRetention(items: readonly RetentionItem[], cfg: VisionConfig): RetentionPlan {
  const totalBytes = items.reduce((n, it) => n + Math.max(0, it.bytes), 0);
  const allIds = items.map((it) => it.id);
  if (totalBytes <= cfg.highWatermarkBytes) {
    return {
      evict: [],
      kept: [...allIds],
      totalBytes,
      evictedBytes: 0,
      keptBytes: totalBytes,
      reason: "below-high",
    };
  }

  const evictCap = Math.ceil(items.length * cfg.evictionRatio);
  const evict: string[] = [];
  const kept: string[] = [];
  let evictedBytes = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const remainingCount = items.length - evict.length;
    const remainingBytes = totalBytes - evictedBytes;
    if (remainingBytes <= cfg.lowWatermarkBytes) {
      kept.push(...allIds.slice(i));
      break;
    }
    if (remainingCount <= cfg.keepRecentImages) {
      kept.push(...allIds.slice(i));
      break;
    }
    if (evict.length >= evictCap) {
      kept.push(...allIds.slice(i));
      break;
    }
    evict.push(item.id);
    evictedBytes += Math.max(0, item.bytes);
  }

  const reason: RetentionPlan["reason"] = evict.length === 0 ? "below-high" : "evicted";
  return {
    evict,
    kept,
    totalBytes,
    evictedBytes,
    keptBytes: totalBytes - evictedBytes,
    reason,
  };
}
