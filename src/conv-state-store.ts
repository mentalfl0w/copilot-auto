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
 *   - compaction invalidation via needsReEval,
 *   - generation-based route staleness detection,
 *   - scoped/global clear for shutdown and credential-disable.
 */

import type { AutoSession, ConvState, LoggerLike, ReasoningBucket } from "./types.ts";
import { DEFAULT_SESSION_OPEN_TIMEOUT_MS } from "./capi-client.ts";
import type { CapiClient } from "./capi-client.ts";

export const DEFAULT_REFRESH_SKEW_MS = 60_000;

interface ConvStateStoreOptions {
  refreshSkewMs?: number;
  sessionOpenTimeoutMs?: number;
}

interface EnsureSessionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function timeoutValue(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

export class ConvStateStore {
  private readonly conversations = new Map<string, ConvState>();
  private readonly refreshSkewMs: number;
  private readonly sessionOpenTimeoutMs: number;

  constructor(
    private readonly client: CapiClient,
    private readonly logger: LoggerLike,
    options: ConvStateStoreOptions = {},
  ) {
    this.refreshSkewMs = timeoutValue(options.refreshSkewMs, DEFAULT_REFRESH_SKEW_MS);
    this.sessionOpenTimeoutMs = timeoutValue(
      options.sessionOpenTimeoutMs,
      DEFAULT_SESSION_OPEN_TIMEOUT_MS,
    );
  }

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
    options: EnsureSessionOptions = {},
  ): Promise<AutoSession | undefined> {
    const conv = this.get(sessionId, autoModelID);
    const routeGeneration = this.getRouteGeneration(conv);

    // Seed the cache with the catalog-level probe result (DESIGN §9.4)
    // before any session-open inflight starts: the very first turn serves
    // the probe session instead of waiting on its own open.
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
      let inflight!: Promise<AutoSession | undefined>;
      inflight = this.client.fetchAutoSession(
        baseURL,
        bearer,
        options.timeoutMs ?? this.sessionOpenTimeoutMs,
        options.signal,
      ).then((session) => {
        if (!this.isRouteCurrent(sessionId, autoModelID, conv, routeGeneration)) {
          return undefined;
        }
        if (session) {
          this.logger.log(
            `session opened: pool=${session.availableModels.length} models, ` +
              `selected=${session.selectedModelID}, expires_in=${Math.max(0, Math.round((session.expiresAtMs - Date.now()) / 1000))}s`,
          );
          conv.session = session;
        }
        return conv.session;
      }).finally(() => {
        if (conv.sessionInflight === inflight) conv.sessionInflight = undefined;
      });
      conv.sessionInflight = inflight;
    }
    return await conv.sessionInflight;
  }

  /** Invalidate sticky routing memory (compaction). Clears session
   *  cache/inflight and increments generation so in-flight route
   *  results from before compaction are rejected. */
  markNeedsReEval(sessionId?: string): void {
    const target = sessionId
      ? [...this.conversations.entries()].filter(([k]) => k.startsWith(`${sessionId}::`))
      : [...this.conversations.entries()];
    for (const [, conv] of target) {
      conv.needsReEval = true;
      conv.sessionInflight = undefined;
      conv.routedReasoningBucket = undefined;
      conv.generation = (conv.generation ?? 0) + 1;
    }
    if (target.length) this.logger.log(`route invalidated by compaction (${target.length} conversation states)`);
  }

  /** Record the routing outcome of a turn. */
  commitRouting(
    conv: ConvState,
    decided: string,
    label: ConvState["routedLabel"],
    omitSessionToken: boolean,
    confidence?: number,
    reasoningBucket?: ReasoningBucket,
  ): void {
    conv.routedModelID = decided;
    conv.routedLabel = label;
    conv.routedReasoningBucket = reasoningBucket;
    conv.routedConfidence = confidence;
    conv.omitSessionToken = omitSessionToken;
    conv.previousModel = decided;
    conv.needsReEval = false;
    conv.turn += 1;
  }



  // ── lifecycle-safe route API ────────────────────────────────────────

  /**
   * Return the generation counter for a conversation before an async
   * route operation begins. Capture this once, pass to isRouteCurrent()
   * when the result arrives.
   */
  getRouteGeneration(conv: ConvState): number {
    return conv.generation ?? 0;
  }

  /**
   * Verify that a route result is still current: the conversation must
   * still live in the store AND its generation must match the captured
   * value. Returns false when compaction/shutdown invalidated the route.
   */
  isRouteCurrent(
    sessionId: string,
    modelId: string,
    conv: ConvState,
    generation: number,
  ): boolean {
    const k = `${sessionId}::${modelId}`;
    return this.conversations.get(k) === conv && (conv.generation ?? 0) === generation;
  }

  /**
   * Invalidate and remove conversation state.
   *
   * Scoped (sessionId provided): removes all model entries for that
   * session from the map, clearing the session state and in-flight promises.
   *
   * Global (no sessionId): removes every conversation. Used on full
   * shutdown or credential-disable.
   */
  clear(sessionId?: string): void {
    const target = sessionId
      ? [...this.conversations.entries()].filter(([key]) => key.startsWith(`${sessionId}::`))
      : [...this.conversations.entries()];
    for (const [key, conv] of target) {
      conv.generation = (conv.generation ?? 0) + 1;
      conv.session = undefined;
      conv.sessionInflight = undefined;
      conv.lastPrompt = undefined;
      conv.hasImage = undefined;
      conv.referenceCount = undefined;
      conv.routedModelID = undefined;
      conv.routedLabel = undefined;
      conv.routedReasoningBucket = undefined;
      conv.routedConfidence = undefined;
      conv.needsReEval = undefined;
      conv.omitSessionToken = undefined;
      conv.previousModel = undefined;
      conv.turn = 0;
      this.conversations.delete(key);
    }
  }
}
