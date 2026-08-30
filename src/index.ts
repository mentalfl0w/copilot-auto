/**
 * copilot-auto — extension entry point.
 *
 * Orchestrator: constructs the collaborators (CapiClient, ConvStateStore,
 * ProviderRegistrar, IntentRouter, FetchPatch) and registers the
 * interception surfaces:
 *
 *   - session_start        — credential resolution + anchor probe +
 *                            registerProvider("github-copilot", [auto])
 *   - input / before_agent_start — capture prompt text / reference count
 *                            for the intent router (interactive editor vs
 *                            RPC AgentSession.prompt; before_agent_start
 *                            fires before the same turn's provider request)
 *   - before_provider_request — per-turn routing: ensureSession → intent
 *                            → payload.model override + reasoning boost
 *   - session_before_compact — invalidate sticky routing memory and drop
 *                            the compacted conversation's queued tokens
 *   - session_shutdown     — restore the fetch patch and clear the
 *                            pending token queue (the next session_start
 *                            recaptures the host's then-current fetch)
 *   - credential_disabled  — re-arm registration for the next session
 *   - /copilot-auto slash command — routing status
 *
 * Lifecycle hardening: session_shutdown restores the fetch patch and
 * clears the pending token queue so no token leaks across sessions;
 * session_before_compact drops the compacted conversation's queued
 * tokens/leases so pre-compaction tokens never stamp a post-compaction
 * request.
 *
 * All hooks are best-effort: routing failures pass the original payload
 * through untouched and never throw into the host.
 */

import type { ExtensionAPI } from "./types.ts";
import { CopilotAuto } from "./copilot-auto.ts";

// Extension host expects a default factory; await load-phase discovery so
// startup model resolution can see the current OMP Auto pool aliases.
export default async function copilotAuto(pi: ExtensionAPI): Promise<void> {
  await new CopilotAuto(pi).registerWithDiscovery();
}
