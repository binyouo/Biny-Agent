export interface DesktopWorkspaceFileMatch {
  name: string;
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
      const normalizedPath = file.path.replace(/\\/gu, "/");
      const lowerPath = normalizedPath.toLocaleLowerCase();
      if (!terms.every(term => lowerPath.includes(term))) return [];
      const lowerName = file.name.toLocaleLowerCase();
      const rank = lowerName === first ? 0 : lowerName.startsWith(first) ? 1 : lowerName.includes(first) ? 2 : 3;
      return [{ file: { ...file, path: normalizedPath }, rank }];
    })
    .sort((left, right) => left.rank - right.rank || left.file.path.length - right.file.path.length)
    .slice(0, limit)
    .map(result => result.file);
}
