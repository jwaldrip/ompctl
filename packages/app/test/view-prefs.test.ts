/**
 * View preferences persistence tests.
 *
 * Proves that fleet view preferences (sort, grouped, project, hubDismissed)
 * round-trip through the storage seam (AsyncStorage) and persist across
 * simulated relaunches.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

function makeFakeAsyncStorage() {
  const store = new Map<string, string>();
  return {
    store,
    module: {
      default: {
        getItem: async (key: string) => store.get(key) ?? null,
        setItem: async (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: async (key: string) => {
          store.delete(key);
        },
      },
    },
  };
}

const fakeAsyncStorage = makeFakeAsyncStorage();
mock.module("@react-native-async-storage/async-storage", () => fakeAsyncStorage.module);
// Dynamic import required so mock.module("@react-native-async-storage/async-storage")
// is registered before view-prefs.ts is evaluated.
const { DEFAULT_VIEW_PREFS, FLEET_VIEW_PREFS_KEY, coerceViewPrefs, loadViewPrefs, saveViewPrefs } = await import(
  "../src/platform/view-prefs.ts"
);

beforeEach(() => {
  fakeAsyncStorage.store.clear();
});

describe("view preferences defaults and coercion", () => {
  test("returns default preferences when storage is empty", async () => {
    const prefs = await loadViewPrefs();
    expect(prefs).toEqual(DEFAULT_VIEW_PREFS);
    expect(prefs.sort).toEqual({ field: "lastActive", direction: "desc" });
    expect(prefs.grouped).toBe(false);
    expect(prefs.project).toBeNull();
  });

  test("coerces invalid and partial values safely to defaults", () => {
    expect(coerceViewPrefs(null)).toEqual(DEFAULT_VIEW_PREFS);
    expect(coerceViewPrefs("not-an-object")).toEqual(DEFAULT_VIEW_PREFS);

    // Invalid sort field falls back to default sort field
    const invalidField = coerceViewPrefs({
      sort: { field: "invalid_field", direction: "asc" },
      grouped: true,
      project: "/path",
    });
    expect(invalidField.sort.field).toBe("lastActive");
    expect(invalidField.sort.direction).toBe("asc");
    expect(invalidField.grouped).toBe(true);
    expect(invalidField.project).toBe("/path");

    // Invalid direction falls back to default direction
    const invalidDir = coerceViewPrefs({
      sort: { field: "status", direction: "invalid_direction" },
    });
    expect(invalidDir.sort.field).toBe("status");
    expect(invalidDir.sort.direction).toBe("desc");

    // View coercion
    expect(coerceViewPrefs({ view: "board" }).view).toBe("board");
    expect(coerceViewPrefs({ view: "list" }).view).toBe("list");
    expect(coerceViewPrefs({ view: "invalid" }).view).toBeUndefined();
  });
});

describe("view preferences persistence across simulated relaunch", () => {
  test("prefs round-trip through the storage seam", async () => {
    const customPrefs = {
      sort: { field: "size" as const, direction: "asc" as const },
      grouped: true,
      project: "/Users/op/dev/my-project",
      hubDismissed: true,
    };

    await saveViewPrefs(customPrefs);

    // Verify written to storage key
    const raw = fakeAsyncStorage.store.get(FLEET_VIEW_PREFS_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toEqual(customPrefs);

    // Verify loaded back
    const loaded = await loadViewPrefs();
    expect(loaded).toEqual(customPrefs);
  });

  test("prefs persist across a simulated relaunch in a test", async () => {
    // Session 1: operator changes sort, turns on grouping, filters by project
    const session1Prefs = {
      sort: { field: "age" as const, direction: "desc" as const },
      grouped: true,
      project: "/Users/op/dev/repo-1",
      hubDismissed: true,
    };
    await saveViewPrefs(session1Prefs);

    // Simulated relaunch: fresh read from durable storage
    const session2Prefs = await loadViewPrefs();
    expect(session2Prefs.sort).toEqual({ field: "age", direction: "desc" });
    expect(session2Prefs.grouped).toBe(true);
    expect(session2Prefs.project).toBe("/Users/op/dev/repo-1");
    expect(session2Prefs.hubDismissed).toBe(true);
  });

  test("view choice (list | board) persists across storage seam", async () => {
    const boardPrefs = {
      view: "board" as const,
      sort: { field: "lastActive" as const, direction: "desc" as const },
      grouped: false,
      project: null,
    };
    await saveViewPrefs(boardPrefs);
    const loaded = await loadViewPrefs();
    expect(loaded.view).toBe("board");

    const listPrefs = {
      ...boardPrefs,
      view: "list" as const,
    };
    await saveViewPrefs(listPrefs);
    const loadedList = await loadViewPrefs();
    expect(loadedList.view).toBe("list");
  });
});
