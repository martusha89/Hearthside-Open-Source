import { lstatSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'

const metadataCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EIO', 'EBUSY', 'ELOOP', 'EINVAL', 'ENOSYS', 'ENOTSUP'])
function failure(error: unknown): string {
  try {
    const code = (error as { code?: unknown })?.code
    return typeof code === 'string' && metadataCodes.has(code) ? code : 'unavailable'
  } catch { return 'unavailable' }
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Failure-only, bounded metadata. No contents, directory enumeration or SQLite access.
 * Flat fields remain visible through the file logger's default util.format depth.
 */
export function collectStorageMetadata(path: string): Record<string, string | number | undefined> {
  if (path === ':memory:') return { status: 'in_memory' }
  const result: Record<string, string | number | undefined> = { status: 'collected', timing: 'before_close' }
  try {
    const directory = dirname(path)
    for (const [label, target] of [['database', path], ['wal', `${path}-wal`], ['shm', `${path}-shm`], ['journal', `${path}-journal`], ['directory', directory]]) {
      try {
        const stat = lstatSync(target!)
        result[`${label}Status`] = 'present'
        result[`${label}Type`] = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other'
        result[`${label}Bytes`] = number(stat.size)
        result[`${label}Mode`] = number(stat.mode) === undefined ? undefined : stat.mode & 0o777
      } catch (error) { result[`${label}Status`] = failure(error) }
    }
    // One volume query, only on the known database directory, never on sidecars.
    try {
      const volume = statfsSync(directory)
      result.volumeStatus = 'available'
      result.volumeBlockBytes = number(volume.bsize)
      result.volumeAvailableBlocks = number(volume.bavail)
      result.volumeTotalBlocks = number(volume.blocks)
    } catch (error) { result.volumeStatus = failure(error) }
  } catch { result.status = 'unavailable' }
  return result
}
