import { constants, promises as fs } from "node:fs";

/** Flush POSIX directory entries after publication. Windows does not support
 * fsync on a read-only directory handle; callers still flush their writable
 * file handle before publication. This does not promise Windows crash durability
 * for the rename/link itself. Do not suppress genuine POSIX I/O errors. */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
