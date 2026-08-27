# copilot-auto

GitHub Copilot **auto**-session routing for **oh-my-pi (OMP)**: injects a single `github-copilot/auto` shell model, drives Copilot's auto-session endpoints (`POST /models/session`, `POST /models/session/intent`), and stamps the per-conversation `Copilot-Session-Token` onto outgoing chat requests. Instead of picking one Copilot catalog model up front, you select `github-copilot/auto` and let GitHub's router — plus this extension's endpoint-aware selection policy — pick the wire model per prompt.

## How it works

```
you:  omp --model github-copilot/auto "explain this diff"
       │
   CopilotAuto (extension)
       ├─ load phase   registerProvider("github-copilot", [auto])
       │               — required BEFORE OMP resolves --model / the session
       │                 model scope; the OAuth credential is resolved lazily
       │                 from stored OMP auth (provider id unchanged)
       ├─ session_start  resolve bearer → probe POST /models/session →
       │                 re-anchor the shell model to the session pool's
       │                 endpoint family (openai-responses | openai-completions
       │                 | anthropic-messages + account-specific base URL)
       ├─ input / before_agent_start   capture prompt text + image count
       │                               (interactive editor vs RPC AgentSession)
       ├─ before_provider_request      per-turn routing:
       │     ensureSession (refresh ≤60s before expiry) →
       │     POST /models/session/intent (1s abort) → payload.model override
       │     + reasoning boost → queue this turn's session token
       ├─ FetchPatch      stamps Copilot-Session-Token on the chat POST
       │                  (per wire model, FIFO — one token per turn)
       ├─ session_before_compact   invalidate sticky routing, drop the
       │                           compacted conversation's queued tokens
       └─ session_shutdown         restore the fetch patch, clear the queue
```

All hooks are best-effort: a routing failure passes the original payload through untouched and never throws into the host.

## Prerequisites

- **oh-my-pi (OMP)** — the extension targets the OMP extension API (`pi.on(...)`, `before_provider_request`, `session_start`, ...).
- **GitHub Copilot OAuth** — an active Copilot subscription with the credential stored in OMP (`/login github-copilot`). The extension reuses the stored OAuth through the unchanged `github-copilot` provider id — it ships **no** `models.yml` and **no** credential handling of its own.
- **Bun** (for build/test/typecheck) — no runtime dependencies.

## Install / development

The extension entry is the built bundle `dist/index.js` (manifest: `package.json` → `"omp".extensions` / legacy `"pi".extensions`), so build before linking:

```sh
cd copilot-auto
bun install        # devDependencies only (@types/bun, typescript)
bun run build      # → dist/index.js
```

Development link (OMP plugin manager):

```sh
omp plugin link /path/to/copilot-auto
```

Alternatively, add the built package to the extension list in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - copilot-auto
```

Restart OMP after installing or editing. Verification: `omp models find auto` should return exactly one model — `github-copilot/auto`.

## Usage

Select the auto model wherever OMP asks for a model:

```sh
omp --model github-copilot/auto
```

```yaml
# ~/.omp/agent/config.yml
model: github-copilot/auto
```

Per-turn routing (and the selected wire model id, label, confidence and source) is logged to `~/.omp/logs/copilot-auto.log`; the status bar shows `copilot-auto: ready (<family>)` and the routing target per turn. The `/copilot-auto` slash command shows the current endpoint anchor and credential state.

Usage accounting keeps working through the host: statistics are recorded under the original catalog model entry, so premium usage lands on the `github-copilot` provider. View it with the OMP usage commands:

```
/usage show                  # TUI
omp usage --provider github-copilot
```

### Optional `enabledModels` allowlist

The plugin registers its model under the builtin `github-copilot` provider, which OMP merges onto its live catalog. If you already restrict the model picker with `enabledModels`, keep your existing entries (for example `openai-codex/*`, `opencode-go/*`) and add the auto model:

```yaml
# ~/.omp/agent/config.yml (or project .omp/config.yml)
enabledModels:
  - openai-codex/*
  - opencode-go/*
  - github-copilot/auto
```

## Endpoint-aware routing

A Copilot auto session returns a pool of available wire models. The extension picks the anchor **endpoint** for the shell model first (one probe per session start), then routes each turn only inside that endpoint:

- **Endpoint families**: `openai-responses` (`/responses`), `openai-completions` (`/chat/completions`), `anthropic-messages` (`/v1/messages`).
- **Account-specific base URL**: the current Copilot GPT/MAI/Gemini catalog is served from `api.individual.githubcopilot.com`; the anthropic family lives on `api.githubcopilot.com`. Both hosts are recognized; CAPI control endpoints stay on the generic host.
- **Anchor selection**: pool ids are grouped by (wire API + normalized base URL) — catalog metadata first, then a conservative heuristic (claude → anthropic-messages, gemini → openai-completions, gpt/codex/mai → openai-responses). The family with the most pool members anchors the shell model.
- **Selection policy**: a pool id is eligible only when its chat endpoint equals the anchor's. Unknown ids (no catalog entry, no heuristic match) are never token-stamped; a responses-family id is never sent to a chat-completions transport and vice versa. Intent candidates from outside the anchor endpoint are dropped.
- **Reasoning boost** (only on `needs_reasoning` turns, keyed to the anchor family): anthropic → `thinking { enabled, budget_tokens }`, openai-completions → `reasoning_effort: high`, openai-responses → `reasoning { effort, summary }` (existing fields preserved; stale effort flags dropped).

Sticky routing remembers the previous verdict per conversation; session compaction invalidates it so a compacted conversation is re-evaluated.

## Session token injection

OMP's extension API has no header-grade seam for chat requests, so the extension patches `globalThis.fetch` (the same in-process convention OMP core ships). The patch:

- intercepts only `POST`s to the two Copilot chat hosts on supported chat paths — control endpoints (`/models/session`, `/models/session/intent`) and look-alike hosts pass through untouched;
- stamps the token queued for **this** turn's wire model (FIFO per model, session-tagged) — never a scan of conversation state, so concurrent sessions routing the same model each get their own conversation's token;
- reuses a token for byte-identical retries (lease per request fingerprint, released on error/429/5xx) instead of consuming another session's token;
- never logs tokens; failures fall through to the original fetch.

## Architecture

Object-oriented, dependency-inverted (smart-approve convention); every concern is a class:

```
CopilotAuto (orchestrator)           — hook wiring, prompt capture, lifecycle
 ├─ ProviderRegistrar                — load-phase github-copilot/auto registration
 │                                    + session_start re-anchor (bearer → probe → endpoint)
 ├─ CapiClient                       — POST /models/session + /models/session/intent
 ├─ ConvStateStore                   — per (sessionId × auto) session token + sticky routing
 ├─ IntentRouter                     — endpoint-aware pool selection + reasoning boost
 ├─ FetchPatch                       — globalThis.fetch patch stamping Copilot-Session-Token
 ├─ PendingTokenQueue                — FIFO per-wire-model token queue, session-tagged
 ├─ RequestLeaseTable                — retry lease for byte-identical chat POSTs
 └─ Logger / RotatingLog             — ~/.omp/logs/copilot-auto.log (5 MB × 3 files, 30 days)
```

No `@oh-my-pi` import at build time: the host API is consumed through minimal structural interfaces (`types.ts`), so the branch matrix is unit-testable without a running host.

## Limitations (honest scope)

- **OMP merge behavior**: `registerProvider` merges, it does not replace — the builtin Copilot catalog models remain in the registry next to `auto` (expected; the extension API cannot delete them, and an edu/student account cannot use them anyway). Hide them with the optional `enabledModels` allowlist above.
- **One direct endpoint family**: the shell model is a single endpoint (wire API + base URL). Models from other families in the pool are never routed token-stamped through this transport; serving multiple families simultaneously requires an additional proxy endpoint in front of the Copilot API.
- **Registration is per-host-session**: subagent/task runners that do not load extensions bypass routing and send the anchor catalog model directly (acceptable degradation — no extension, no auto).
- **Routing is best-effort**: intent-endpoint failures, probe timeouts or missing credentials leave the payload untouched (or, without a credential, leave the extension idle until the credential is re-enabled).

## Tests / build

```sh
bun test src        # node:test suites: orchestrator, registrar, intent router,
                    # fetch patch, capi client, conv state, pending token queue
bun run typecheck   # tsc --noEmit
bun run build       # bun build src/index.ts --outdir dist --target bun
```

## License

MIT
