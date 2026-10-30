export interface DesktopWorkspaceFileMatch {
  name: string;
  /** Workspace-relative path; the producer normalizes only native platform separators. */
  path: string;
}

export interface DesktopWorkspaceFileIndex {
  files: DesktopWorkspaceFileMatch[];
  incomplete: boolean;
}

export function matchDesktopWorkspaceFiles(files: DesktopWorkspaceFileMatch[], query: string, limit = 8): DesktopWorkspaceFileMatch[] {
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return [];
  const first = terms[0]!;
  return files
    .flatMap(file => {
      const lowerPath = file.path.toLocaleLowerCase();
      if (!terms.every(term => lowerPath.includes(term))) return [];
      const lowerName = file.name.toLocaleLowerCase();
      const rank = lowerName === first ? 0 : lowerName.startsWith(first) ? 1 : lowerName.includes(first) ? 2 : 3;
      return [{ file, rank }];
    })
    .sort((left, right) => left.rank - right.rank || left.file.path.length - right.file.path.length)
    .slice(0, limit)
    .map(result => result.file);
}
