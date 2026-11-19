import { safeStorage } from "electron";




/** Linux backends backed by a real keyring service. Anything else is not protection. */
const PROTECTED_LINUX_BACKENDS = new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]);

export type ProtectedStorageProblem =
  /** No OS protected storage at all. */
  | "unavailable"
  /** Protected storage answers, but what is behind it does not protect anything. */
  | "unprotected-backend";

/** Null when a new secret may be written. Reading existing values is never gated on this. */
export function protectedStorageProblem(): ProtectedStorageProblem | null {
  let available: boolean;
  try {
    available = safeStorage.isEncryptionAvailable();
  } catch {
    return "unavailable";
  }
  if (!available) return "unavailable";
  // Windows (DPAPI) and macOS (Keychain) have one backend each, and it protects.
  if (process.platform !== "linux") return null;
  let backend: string;
  try {
    backend = safeStorage.getSelectedStorageBackend?.() ?? "unknown";
  } catch {
    // Fail closed: a backend we cannot name is not a backend we can vouch for.
    backend = "unknown";
  }
  return PROTECTED_LINUX_BACKENDS.has(backend) ? null : "unprotected-backend";
}

/**
 * The sentence to show for a problem, with `what` naming the thing not saved
 * ("this secret", "this backup's key"). Both endings say plainly that nothing was
 * written in the clear, because the previous behaviour was exactly that.
 */
export function protectedStorageMessage(problem: ProtectedStorageProblem, what: string): string {
  if (problem === "unprotected-backend") {
    return `This computer's protected storage isn't backed by a keyring (its login keychain isn't running), so anything saved through it could be read straight back. Hearthside won't save ${what} that way. Start your desktop keyring (GNOME Keyring or KWallet), or pass the value through the environment instead.`;
  }
  return `This computer has no protected storage (its keychain), so Hearthside won't save ${what}. It is never written in the clear. Set up a keychain, or pass the value through the environment instead.`;
}
