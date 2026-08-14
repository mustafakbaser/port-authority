import * as fs from 'node:fs/promises';
import type { FileSystemReader } from '../core/exec.js';

/**
 * Real file system access for the Linux `/proc` scanner.
 *
 * This is one of the two places in the extension that bypasses `vscode.workspace.fs`,
 * and the reason is concrete: `/proc` is a kernel-backed pseudo file system on the
 * machine running the extension host, not a workspace resource. `readlink` on
 * `/proc/<pid>/fd/<n>` has no equivalent in the workspace file system API at all.
 */
export const nodeFileSystem: FileSystemReader = {
  readFile: (path) => fs.readFile(path, 'utf8'),
  readLink: (path) => fs.readlink(path),
  readDir: (path) => fs.readdir(path),
  exists: async (path) => {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  },
};
