import assert from "node:assert/strict";
import test from "node:test";
import { loadRecentSearches, rememberRecentSearch, removeRecentSearch, type RecentSearchStorage } from "../src/desktop/recentSearches.js";

function createStorage(initial: string | null = null): RecentSearchStorage {
  let value = initial;
  return {
    getItem() { return value; },
    setItem(_key, next) { value = next; }
  };
}

test("recent searches trim, deduplicate case-insensitively, and keep the newest six", () => {
  const storage = createStorage();
  assert.deepEqual(rememberRecentSearch(storage, "  README  "), ["README"]);
  assert.deepEqual(rememberRecentSearch(storage, "readme"), ["readme"]);
  assert.deepEqual(rememberRecentSearch(storage, "x"), ["readme"]);
  for (const query of ["two", "three", "four", "five", "six", "seven"]) rememberRecentSearch(storage, query);
  assert.deepEqual(loadRecentSearches(storage), ["seven", "six", "five", "four", "three", "two"]);
});

test("recent search loading tolerates invalid data and removal is persisted", () => {
  assert.deepEqual(loadRecentSearches(createStorage("not json")), []);
  const storage = createStorage(JSON.stringify(["first", 2, "second", "  "]));
  assert.deepEqual(loadRecentSearches(storage), ["first", "second"]);
  assert.deepEqual(removeRecentSearch(storage, "first"), ["second"]);
  assert.deepEqual(loadRecentSearches(storage), ["second"]);
});
