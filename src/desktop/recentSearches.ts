const RECENT_SEARCHES_KEY = "biny.desktop.recent-searches";
const RECENT_SEARCHES_LIMIT = 6;

export interface RecentSearchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadRecentSearches(storage: RecentSearchStorage | null): string[] {
  if (!storage) return [];
  try {
    const value: unknown = JSON.parse(storage.getItem(RECENT_SEARCHES_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((query): query is string => typeof query === "string" && query.trim().length > 0).slice(0, RECENT_SEARCHES_LIMIT);
  } catch {
    return [];
  }
}

export function rememberRecentSearch(storage: RecentSearchStorage | null, query: string): string[] {
  const normalized = query.trim();
  const recent = loadRecentSearches(storage);
  if (normalized.length < 2) return recent;
  const updated = [normalized, ...recent.filter(item => item.toLowerCase() !== normalized.toLowerCase())].slice(0, RECENT_SEARCHES_LIMIT);
  return saveRecentSearches(storage, updated);
}

export function removeRecentSearch(storage: RecentSearchStorage | null, query: string): string[] {
  return saveRecentSearches(storage, loadRecentSearches(storage).filter(item => item !== query));
}

function saveRecentSearches(storage: RecentSearchStorage | null, queries: string[]): string[] {
  try {
    storage?.setItem(RECENT_SEARCHES_KEY, JSON.stringify(queries));
  } catch {
    // A storage failure should not interrupt searching in the current window.
  }
  return queries;
}
