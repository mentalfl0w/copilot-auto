/**
 * copilot-auto — conversation state store.
 *
 * Owns the per (sessionID × autoModel) ConvState map: the Copilot auto
 * session (token + pool) and the sticky routing memory. Implements the
 * lifecycle from DESIGN.md §7:
 *   - lazy open on first use,
 *   - refresh SESSION_REFRESH_SKEW_MS before server expiry,
 *   - single-flight dedup of concurrent ensureSession() calls,
 *   - stale-token tolerance when a refresh fails,
 *   - compaction invalidation via needsReEval.
 */

import type { AutoSession, ConvState, LoggerLike } from "./types.ts";
import type { CapiClient } from "./capi-client.ts";

export const DEFAULT_REFRESH_SKEW_MS = 60_000;

export class ConvStateStore {
  private readonly conversations = new Map<string, ConvState>();

  constructor(
    private readonly client: CapiClient,
    private readonly logger: LoggerLike,
    private readonly refreshSkewMs: number = DEFAULT_REFRESH_SKEW_MS,
  ) {}

  /** Get or create the state for one conversation × auto model. The
   *  composite string key makes the map dynamic (runtime insert per turn). */
  get(sessionId: string, modelId: string): ConvState {
    const k = `${sessionId}::${modelId}`;
    let conv = this.conversations.get(k);
    if (!conv) {
      conv = { turn: 0 };
      this.conversations.set(k, conv);
    }
    return conv;
  }

  /** Iterate all live conversation states (input capture, token lookup). */
  allConversations(): IterableIterator<ConvState> {
    return this.conversations.values();
  }

  /**
   * Return a live AutoSession for this conversation, opening or refreshing
   * it as needed. Concurrent callers share one in-flight promise; a failed
   * refresh keeps serving the stale token until it is truly unusable.
   */
  async ensureSession(
    sessionId: string,
    autoModelID: string,
    baseURL: string,
    bearer: string | undefined,
    seeded?: AutoSession,
  ): Promise<AutoSession | undefined> {
    const conv = this.get(sessionId, autoModelID);

    // Seed the cache with the catalog-level probe result (DESIGN §9.4)
    // before any session-open inflight starts: the very first turn serves
    // the probe session instead of waiting on its own open. Assigning
    // synchronously here also makes seeding work when a turn races an
    // existing inflight; once a session exists this is a no-op, and the
    // freshness/refresh logic below applies to the seeded value too.
    if (!conv.session && seeded) {
      conv.session = seeded;
      this.logger.log(
        `session seeded: pool=${seeded.availableModels.length} models, ` +
          `selected=${seeded.selectedModelID}, expires_in=${Math.max(0, Math.round((seeded.expiresAtMs - Date.now()) / 1000))}s`,
      );
    }

    const now = Date.now();
    if (conv.session && now < conv.session.expiresAtMs - this.refreshSkewMs) {
      return conv.session;
    }
    if (!bearer) return conv.session;
    if (!conv.sessionInflight) {
      conv.sessionInflight = this.client.fetchAutoSession(baseURL, bearer).then((session) => {
        if (session) {
          this.logger.log(
            `session opened: pool=${session.availableModels.length} models, ` +
              `selected=${session.selectedModelID}, expires_in=${Math.max(0, Math.round((session.expiresAtMs - Date.now()) / 1000))}s`,
          );
          conv.session = session;
        }
        return conv.session;
      }).finally(() => {
        conv.sessionInflight = undefined;
      });
    }
    return await conv.sessionInflight;
  }

  /** Invalidate sticky routing memory (compaction). */
  markNeedsReEval(sessionId?: string): void {
    const target = sessionId
      ? [...this.conversations.entries()].filter(([k]) => k.startsWith(`${sessionId}::`))
      : [...this.conversations.entries()];
    for (const [, conv] of target) conv.needsReEval = true;
    if (target.length) this.logger.log(`route invalidated by compaction (${target.length} conversation states)`);
  }

  /** Record the routing outcome of a turn. */
  commitRouting(
    conv: ConvState,
    decided: string,
    label: ConvState["routedLabel"],
    omitSessionToken: boolean,
    confidence?: number,
  ): void {
    conv.routedModelID = decided;
    conv.routedLabel = label;
    conv.routedConfidence = confidence;
    conv.omitSessionToken = omitSessionToken;
    conv.previousModel = decided;
    conv.needsReEval = false;
    conv.turn += 1;
  }

  /** True when apiId belongs to the anchor family's session pool. */
  inPool(conv: ConvState, apiId: string): boolean {
    return conv.session?.availableModels.includes(apiId) ?? false;
  }
}
