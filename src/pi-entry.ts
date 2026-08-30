import { lazyStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "./types.ts";
import copilotAuto from "./index.ts";

/** Pi host entry: install host-native lazy stream helper. */
export default async function piCopilotAuto(pi: ExtensionAPI): Promise<void> {
  pi.lazyStream = lazyStream as unknown as ExtensionAPI["lazyStream"];
  await copilotAuto(pi);
}
