import path from "node:path";
import { scanWorkspaceFiles } from "../workspace/scanner.js";
import type { DesktopWorkspaceFileIndex } from "./projectFiles.js";

const maxIndexedFiles = 20_000;

export async function readDesktopWorkspaceFileIndex(root: string, ignore: string[]): Promise<DesktopWorkspaceFileIndex> {
  let skippedDirectory = false;
  const paths = await scanWorkspaceFiles(root, ignore, maxIndexedFiles + 1, undefined, undefined, undefined, () => {
    skippedDirectory = true;
  });
  const incomplete = skippedDirectory || paths.length > maxIndexedFiles;
  return {
    files: paths.slice(0, maxIndexedFiles).map(filePath => {
      const normalizedPath = filePath.split(path.sep).join("/");
      return { name: path.posix.basename(normalizedPath), path: normalizedPath };
    }),
    incomplete
  };
}
