/// <reference types="vite/client" />
import type { AppBridge } from "@hearthside/ipc-contract";

declare global {
  interface Window {
    /** Bridge to the Electron main process, exposed by src/preload/index.ts. */
    bridge: AppBridge;
  }
}
