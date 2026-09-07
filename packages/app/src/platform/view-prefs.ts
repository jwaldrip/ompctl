/**
 * Persistent view preferences for the session browser.
 *
 * Saves and restores the active sort, grouping toggle, project filter,
 * and whether the agent hub hint has been collapsed/dismissed.
 *
 * Reuses the same storage seam as connection.ts: AsyncStorage on native,
 * localStorage on web.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_SORT, type SortField, type SortSpec } from "../session/browser.ts";

export const FLEET_VIEW_PREFS_KEY = "ompd.fleet.view";

export interface FleetViewPrefs {
  readonly sort: SortSpec;
  readonly grouped: boolean;
  readonly project: string | null;
  readonly hubDismissed?: boolean;
}

export const DEFAULT_VIEW_PREFS: FleetViewPrefs = {
  sort: DEFAULT_SORT,
  grouped: false,
  project: null,
  hubDismissed: false,
};

const VALID_SORT_FIELDS: ReadonlySet<SortField> = new Set([
  "status",
  "age",
  "lastActive",
  "messageCount",
  "size",
]);

function coerceSort(value: unknown): SortSpec {
  if (typeof value !== "object" || value === null) return DEFAULT_SORT;
  const candidate = value as Record<string, unknown>;
  const field =
    typeof candidate.field === "string" && VALID_SORT_FIELDS.has(candidate.field as SortField)
      ? (candidate.field as SortField)
      : DEFAULT_SORT.field;
  const direction =
    candidate.direction === "asc" || candidate.direction === "desc" ? candidate.direction : DEFAULT_SORT.direction;
  return { field, direction };
}

export function coerceViewPrefs(value: unknown): FleetViewPrefs {
  if (typeof value !== "object" || value === null) return DEFAULT_VIEW_PREFS;
  const raw = value as Record<string, unknown>;
  const sort = coerceSort(raw.sort);
  const grouped = typeof raw.grouped === "boolean" ? raw.grouped : DEFAULT_VIEW_PREFS.grouped;
  const project = typeof raw.project === "string" ? raw.project : null;
  const hubDismissed = typeof raw.hubDismissed === "boolean" ? raw.hubDismissed : undefined;
  return {
    sort,
    grouped,
    project,
    ...(hubDismissed !== undefined ? { hubDismissed } : {}),
  };
}

/** Load view preferences from persistent storage. */
export async function loadViewPrefs(): Promise<FleetViewPrefs> {
  try {
    const raw = await AsyncStorage.getItem(FLEET_VIEW_PREFS_KEY);
    if (raw === null) return DEFAULT_VIEW_PREFS;
    const parsed = JSON.parse(raw);
    return coerceViewPrefs(parsed);
  } catch {
    return DEFAULT_VIEW_PREFS;
  }
}

/** Save view preferences to persistent storage. */
export async function saveViewPrefs(prefs: FleetViewPrefs): Promise<void> {
  try {
    await AsyncStorage.setItem(FLEET_VIEW_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Failure to persist UI preferences is non-fatal.
  }
}
