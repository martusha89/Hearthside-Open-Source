import { reopenGatewayAfterFailedQuit, shutdownGateway } from "./channel-gateway";
import { closeAllConnectors } from "./connectors";
import { cancelAllImageSetup } from "./image-setup";
import { cancelLettaSignIn } from "./letta-signin";
import { runtimeStoppedStrict } from "./owned-server";
import { cancelAllProviderSignIns } from "./provider-signin";
import { closeForQuit, disconnect, reopenAfterFailedQuit } from "./runtime";
import { computerListenerStopped, shutdownComputerListener } from "./computer-access";

async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Shutdown timed out; installation is blocked until owned processes have exited.")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

/**
 * Hearthside: stop everything Hearthside started, in order, before quitting or
 * installing an update. Nothing may reconnect meanwhile (the chat's background
 * refresh once restarted the runtime mid-update, and the installer then found
 * Hearthside "running"). Waits, within `limitMs`, for the runtime to exit.
 */
export async function shutdownForQuit(limitMs: number): Promise<void> {
  const started = Date.now();
  closeForQuit();
  cancelAllProviderSignIns();
  // Hearthside: stops only a download or sign-in this app started; it never
  // signs the person out of Codex or stops a Codex they are running themselves.
  cancelAllImageSetup();
  cancelLettaSignIn();
  shutdownComputerListener();
  try {
    await within(Promise.all([disconnect(), closeAllConnectors(), shutdownGateway(), computerListenerStopped()]), limitMs);
    const left = Math.max(0, limitMs - (Date.now() - started));
    await runtimeStoppedStrict(left);
  } catch (error) {
    // The app is not exiting after all. Left "closing", every later action
    // answered "Hearthside is closing" until the process was killed.
    reopenAfterFailedQuit();
    reopenGatewayAfterFailedQuit();
    throw error;
  }
}
