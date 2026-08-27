/**
 * Pi-host simulation test — loads the built dist artifact the way Pi's
 * extension loader does (Node.js module loading of the bundled JS,
 * WITHOUT a Bun runtime and WITHOUT @oh-my-pi/@earendil-works packages).
 *
 * The artifact is copied into an ISOLATED temp directory that contains
 * no node_modules at all, so any hidden host import (`@oh-my-pi/*`,
 * `@earendil-works/*`, or any npm package) would fail to resolve exactly
 * as it would under a production `pi install npm:copilot-auto` that only
 * ships `dist/`. A minimal `{"type":"module"}` package.json makes Node
 * treat the copied bundle as ESM (Pi's jiti loader auto-detects; plain
 * Node needs the marker).
 *
 * Checks:
 *   A. dist/index.js loads via Node import(), the factory runs, the
 *      `/copilot-auto` command registers, and the load-phase
 *      registerProvider registers `github-copilot/auto` with NO
 *      credential and NO `oauth` marker (Pi must inherit its built-in
 *      GitHub Copilot OAuth — a bare marker would be adapted as a
 *      complete ExtensionOAuthConfig and break it).
 *   B. HOME is isolated so the extension's file logger writes inside
 *      the temp home (proves node:fs works under plain Node).
 *   C. No Bun global required anywhere.
 *
 * Run: node scripts/test-pi-load.mjs
 */
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// ── Isolate BOTH the module-load dir and HOME ──
const simDir = mkdtempSync(join(tmpdir(), "copilot-auto-pi-sim-"));
mkdirSync(join(simDir, "ext"), { recursive: true });
// Copy the artifact OUT of the repo so no node_modules is reachable by
// walking up — @oh-my-pi/* and friends must genuinely fail to resolve.
cpSync(join(repoRoot, "dist", "index.js"), join(simDir, "ext", "index.js"));
// Plain Node treats .js as CJS without a package.json; Pi's jiti loader
// auto-detects ESM, so this marker only mirrors the package's real
// "type": "module" field in the isolated copy.
writeFileSync(join(simDir, "ext", "package.json"), JSON.stringify({ type: "module" }));
// NO credentials.json anywhere → the factory must still return
// successfully and register the model (issue #1 lesson: load-time
// failures must never prevent command/extension registration).
process.env.HOME = join(simDir, "home");
mkdirSync(join(simDir, "home"), { recursive: true });

// ── A. Load the built artifact and drive the extension surface ──
const mod = await import(pathToFileURL(join(simDir, "ext", "index.js")).href);
const factory = mod.default ?? mod;
if (typeof factory !== "function") {
  throw new Error(`FAIL: dist export is not a factory function (${typeof factory})`);
}
console.log("PASS: dist/index.js loaded via Node import() (isolated, @oh-my-pi unresolvable)");

const commands = new Map();
const registrations = [];
const api = {
  // Pi does NOT inject the `pi` self-reference (OMP does) — the
  // runtime discriminator must classify this as Pi.
  pi: undefined,
  on: () => {},
  registerCommand: (name, def) => commands.set(name, def),
  registerProvider: (providerId, config) => registrations.push({ providerId, ...config }),
};

// The factory must return successfully with NO credential present.
await factory(api);
console.log("PASS: factory returned successfully with no credential");

if (!commands.has("copilot-auto")) {
  throw new Error("FAIL: /copilot-auto command not registered");
}
console.log("PASS: /copilot-auto command registered");

if (registrations.length !== 1) {
  throw new Error(`FAIL: expected exactly one load-phase registration, got ${registrations.length}`);
}
const load = registrations[0];
if (load.providerId !== "github-copilot") {
  throw new Error(`FAIL: expected provider github-copilot, got ${load.providerId}`);
}
if (load.oauth !== undefined) {
  throw new Error("FAIL: Pi must NOT receive an oauth marker (it inherits the built-in Copilot OAuth)");
}
if (load.apiKey !== undefined) {
  throw new Error("FAIL: no credential exists at load — apiKey must be deferred");
}
if (load.models?.length !== 1 || load.models[0].id !== "auto") {
  throw new Error(`FAIL: expected the single 'auto' model, got ${JSON.stringify(load.models)}`);
}
console.log("PASS: load-phase registration is credential-less and marker-free (github-copilot/auto)");

// ── B. File logger works under plain Node with an isolated HOME ──
const logPath = join(simDir, "home", ".omp", "agent", "copilot-auto.log");
if (!existsSync(logPath)) {
  throw new Error("FAIL: extension log not written under isolated HOME (node:fs broken in Node)");
}
console.log("PASS: file logger wrote to the isolated HOME (node:fs works under Node)");

// ── C. No Bun global required anywhere ──
if (typeof globalThis.Bun !== "undefined") {
  console.log("WARN: Bun global is defined in this Node process");
} else {
  console.log("PASS: ran entirely without a Bun global");
}

// Cleanup
rmSync(simDir, { recursive: true, force: true });
console.log("\nALL TESTS PASSED");
// The extension keeps no timers at load; exit explicitly so the test
// runner never hangs on stray handles.
process.exit(0);
