import type { AppEvent, ReadyUpdate, UpdateCheck } from "@hearthside/ipc-contract";
export const automaticUpdatesSupported = (_platform?: NodeJS.Platform) => false;
export function initUpdater(_emit: (event: AppEvent) => void): void {}
export async function checkForUpdatesNow(): Promise<UpdateCheck> { return { status: "error", message: "Update this source build manually." }; }
export function updateReady(): ReadyUpdate | null { return null; }
export class ReplyRunningError extends Error {}
export async function installUpdate(_prepare: () => Promise<void>, _undo?: () => void): Promise<void> { throw new Error("Automatic updates disabled."); }
