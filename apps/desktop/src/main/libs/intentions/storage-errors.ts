import { collectStorageMetadata } from './storage-metadata'

// SQLite result-code names, NOT Windows error numbers (sqlite.org/rescode.html).
const ioerrNames = ['READ', 'SHORT_READ', 'WRITE', 'FSYNC', 'DIR_FSYNC', 'TRUNCATE', 'FSTAT', 'UNLOCK', 'RDLOCK', 'DELETE', 'BLOCKED', 'NOMEM', 'ACCESS', 'CHECKRESERVEDLOCK', 'LOCK', 'CLOSE', 'DIR_CLOSE', 'SHMOPEN', 'SHMSIZE', 'SHMLOCK', 'SHMMAP', 'SEEK', 'DELETE_NOENT', 'MMAP', 'GETTEMPPATH', 'CONVPATH', 'VNODE', 'AUTH', 'BEGIN_ATOMIC', 'COMMIT_ATOMIC', 'ROLLBACK_ATOMIC', 'DATA', 'CORRUPTFS', 'IN_PAGE'] as const
const syscalls = new Set(['open', 'close', 'read', 'write', 'fsync', 'fdatasync', 'ftruncate', 'truncate', 'stat', 'lstat', 'fstat', 'statfs', 'mkdir', 'chmod', 'unlink', 'rename'])

// Only caller-owned operation constants belong here, never SQL or user input.
const filesystemCodes = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOSPC', 'EDQUOT', 'EROFS',
  'EIO', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY',
  'EINVAL', 'EBADF', 'ELOOP', 'ENAMETOOLONG', 'EXDEV', 'ENODEV', 'ENXIO',
])

function instanceOf<T extends Error>(error: unknown, type: new (...args: never[]) => T): error is T {
  try { return error instanceof type } catch { return false }
}

function field(error: unknown, key: string): unknown {
  try {
    return error !== null && typeof error === 'object'
      ? (error as Record<string, unknown>)[key]
      : undefined
  } catch {
    return undefined
  }
}

function sqliteCode(value: unknown): value is string {
  return value === 'ERR_SQLITE_ERROR' || value === 'ERR_SQLITE_BUSY'
}

function safeCode(error: unknown): string | undefined {
  const code = field(error, 'code')
  return sqliteCode(code) || (typeof code === 'string' && filesystemCodes.has(code))
    ? code as string
    : undefined
}

function safeStack(error: unknown): string[] {
  const stack = field(error, 'stack')
  if (typeof stack !== 'string') return []
  return stack.slice(0, 16384).split('\n').slice(1, 41).flatMap((line) => {
    // Accept V8 source frames only. Never emit the error headline or URL frames.
    const match = /^\s+at (?:(?:async )?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*) \()?(.+):(\d+):(\d+)\)?$/.exec(line)
    if (!match) return []
    const [, name, source, row, column] = match
    if (!source || /[?#]|:\/\//.test(source)) return []
    const basename = source.split(/[\\/]/).pop()
    if (!basename || !/^[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?)$/.test(basename)) return []
    return [`at ${name ? `${name} (` : ''}${basename}:${row}:${column}${name ? ')' : ''}`]
  })
}

class IntentionsStorageError extends Error {
  constructor(readonly operation: string, readonly code?: string, readonly errcode?: number) {
    const details = [code, errcode === undefined ? undefined : `SQLite ${errcode}`].filter(Boolean)
    super(`Intentions storage could not ${operation}${details.length ? ` (${details.join('; ')})` : ''}. Your stored data has not been reset.`)
    this.name = 'IntentionsStorageError'
  }
}

/** Recognizes our reported failures and native SQLite failures, not domain errors. */
export function isIntentionsStorageError(error: unknown): boolean {
  // Preserve the existing recognition boundary. Logging has a stricter allowlist
  // so an unknown/future SQLite code cannot become arbitrary diagnostic text.
  const code = field(error, 'code')
  return instanceOf(error, IntentionsStorageError) ||
    (typeof code === 'string' && /^ERR_SQLITE_[A-Z0-9_]{1,64}$/.test(code))
}

/** Reports safe diagnostics once; returned errors retain their first operation. */
export function reportIntentionsStorageError(error: unknown, operation: string, initializationPath?: string): Error {
  if (instanceOf(error, IntentionsStorageError)) return error
  const code = safeCode(error)
  const rawErrcode = field(error, 'errcode')
  const errcode = typeof rawErrcode === 'number' && Number.isInteger(rawErrcode) && rawErrcode >= 0 && rawErrcode <= 0x7fffffff
    ? rawErrcode
    : undefined
  const category = sqliteCode(code) ? 'SQLiteError'
    : code && filesystemCodes.has(code) ? 'FilesystemError'
      : instanceOf(error, Error) ? 'Error' : 'UnknownError'
  // Diagnostics must never replace the original failure, including a broken sink.
  try {
    const errno = field(error, 'errno')
    const syscall = field(error, 'syscall')
    const ioerr = errcode !== undefined && (errcode & 255) === 10
    const subtype = ioerr && errcode > 10 ? ioerrNames[(errcode >>> 8) - 1] : undefined
    let initializationMetadata: ReturnType<typeof collectStorageMetadata> | undefined
    if (initializationPath !== undefined) {
      try { initializationMetadata = collectStorageMetadata(initializationPath) }
      catch { initializationMetadata = { status: 'unavailable' } }
    }
    console.error('[intentions] Storage operation failed', {
      operation,
      category,
      ...(code === undefined ? {} : { code }),
      ...(errcode === undefined ? {} : { errcode, primaryCode: errcode & 255, extendedCode: errcode }),
      ...(ioerr ? { sqliteSymbol: errcode === 10 ? 'SQLITE_IOERR' : subtype ? `SQLITE_IOERR_${subtype}` : 'SQLITE_IOERR_UNKNOWN_SUBTYPE' } : {}),
      ...(sqliteCode(code) ? { windowsNativeCode: 'unavailable', windowsNativeCodeReason: 'node_sqlite_does_not_expose_native_error' } : {}),
      ...(typeof errno === 'number' && Number.isInteger(errno) && errno >= -2147483648 && errno <= 2147483647
        ? { reportedErrno: errno, errnoSource: 'error.errno_not_windows_last_error' } : {}),
      ...(typeof syscall === 'string' && syscalls.has(syscall) ? { reportedSyscall: syscall, syscallSource: 'error.syscall' } : {}),
      ...(initializationMetadata === undefined ? {} : { initializationMetadata }),
      stack: safeStack(error),
    })
  } catch { /* Best effort only; no retry or secondary diagnostic. */ }
  return new IntentionsStorageError(operation, code, errcode)
}
