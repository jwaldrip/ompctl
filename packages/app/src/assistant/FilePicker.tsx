/**
 * The file picker menu, opened when "@" is typed in a prompt.
 *
 * Rooted at the session's working directory, navigation over `fs_list`
 * with breadcrumbs, and inserts the selected file's relative path into
 * the prompt text.
 */

import type { FsEntry, FsListing } from "@ompd/core/contracts";
import { type JSX, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { Label } from "../design/text.tsx";
import { ground, ink, radius, signal, space, stroke, type } from "../design/tokens.ts";

export interface FilePickerClient {
  listDirectory?(path?: string): void;
  on?(event: string, listener: (listing: FsListing) => void): () => void;
}

export interface FilePickerProps {
  prefix?: string;
  cwd: string;
  onSelect: (relativePath: string) => void;
  onClose?: () => void;
  client?: FilePickerClient;
  listing?: FsListing | null;
  testID?: string;
}

export function relativePath(cwd: string, fullPath: string): string {
  const normCwd = cwd.replace(/\/+$/, "");
  if (fullPath === normCwd) return ".";
  if (fullPath.startsWith(`${normCwd}/`)) {
    return fullPath.slice(normCwd.length + 1);
  }
  return fullPath;
}

export function childPath(base: string, name: string): string {
  if (base === "") return name;
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

export function breadcrumbSegments(cwd: string, current: string): Array<{ label: string; path: string }> {
  const normCwd = cwd.replace(/\/+$/, "");
  const rootName = normCwd.split("/").pop() || "root";
  const segments: Array<{ label: string; path: string }> = [{ label: rootName, path: normCwd }];

  if (current === normCwd || !current.startsWith(`${normCwd}/`)) {
    return segments;
  }

  const rel = current.slice(normCwd.length + 1);
  const parts = rel.split("/").filter(p => p.length > 0);
  let accumulated = normCwd;
  for (const part of parts) {
    accumulated = `${accumulated}/${part}`;
    segments.push({ label: part, path: accumulated });
  }

  return segments;
}

export function FilePicker({
  cwd,
  onSelect,
  onClose,
  client,
  listing,
  testID = "file-picker",
}: FilePickerProps): JSX.Element | null {
  const normCwd = cwd.replace(/\/+$/, "");
  const [currentPath, setCurrentPath] = useState(normCwd);
  const [entries, setEntries] = useState<FsEntry[]>(listing?.entries ?? []);

  useEffect(() => {
    if (listing?.entries) {
      setEntries(listing.entries);
    }
  }, [listing]);

  useEffect(() => {
    if (!client?.listDirectory) return;
    client.listDirectory(currentPath);
  }, [client, currentPath]);

  useEffect(() => {
    if (!client?.on) return;
    const unsub = client.on("fs_listing", (event: FsListing) => {
      if (event.path === currentPath || (currentPath === normCwd && event.path === "")) {
        setEntries(event.entries);
      }
    });
    return unsub;
  }, [client, currentPath, normCwd]);

  const breadcrumbs = useMemo(() => breadcrumbSegments(normCwd, currentPath), [normCwd, currentPath]);

  // Sort directories first, then files alphabetically
  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      if (a.kind === "dir" && b.kind !== "dir") return -1;
      if (a.kind !== "dir" && b.kind === "dir") return 1;
      return a.name.localeCompare(b.name);
    });
  }, [entries]);

  const handleEntryPress = (entry: FsEntry) => {
    const full = childPath(currentPath, entry.name);
    if (entry.kind === "dir") {
      setCurrentPath(full);
      client?.listDirectory?.(full);
    } else {
      const rel = relativePath(normCwd, full);
      onSelect(rel);
    }
  };

  return (
    <View style={styles.card} testID={testID}>
      {/* Header with breadcrumbs and close button */}
      <View style={styles.header}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.breadcrumbsScroll}
          contentContainerStyle={styles.breadcrumbs}
          testID="file-picker-breadcrumbs"
        >
          {breadcrumbs.map((crumb, idx) => (
            <View key={crumb.path} style={styles.crumbRow}>
              {idx > 0 ? <Label style={[type.kicker, styles.crumbSep]}>/</Label> : null}
              <Pressable
                testID={`file-picker-breadcrumb-${idx}`}
                accessibilityRole="button"
                accessibilityLabel={`Go to ${crumb.label}`}
                onPress={() => {
                  setCurrentPath(crumb.path);
                  client?.listDirectory?.(crumb.path);
                }}
                style={({ pressed }) => [styles.crumbBtn, pressed && styles.crumbPressed]}
              >
                <Label style={[type.kicker, idx === breadcrumbs.length - 1 ? styles.crumbActive : styles.crumbText]}>
                  {crumb.label}
                </Label>
              </Pressable>
            </View>
          ))}
        </ScrollView>
        {onClose ? (
          <Pressable
            testID="file-picker-close"
            accessibilityRole="button"
            accessibilityLabel="Close file picker"
            onPress={onClose}
            style={({ pressed }) => [styles.closeBtn, pressed && styles.crumbPressed]}
          >
            <Glyph name="deny" size={11} color={ink.muted} />
          </Pressable>
        ) : null}
      </View>

      {/* Directory entries */}
      <ScrollView style={styles.list} keyboardShouldPersistTaps="always">
        {sortedEntries.length === 0 ? (
          <View style={styles.empty}>
            <Label style={[type.label, styles.emptyText]}>No entries</Label>
          </View>
        ) : (
          sortedEntries.map(entry => {
            const isDir = entry.kind === "dir";
            const glyph = isDir ? (entry.gitRepo ? "repo" : "folder") : entry.kind === "link" ? "symlink" : "read";
            const glyphColor = isDir ? signal.working : ink.muted;

            return (
              <View key={entry.name} style={styles.item}>
                <Pressable
                  testID={`file-picker-entry-${entry.name}`}
                  accessibilityRole="button"
                  accessibilityLabel={isDir ? `Open folder ${entry.name}` : `Select file ${entry.name}`}
                  onPress={() => handleEntryPress(entry)}
                  style={({ pressed }) => [styles.entryMain, pressed && styles.itemPressed]}
                >
                  <Glyph name={glyph} size={13} color={glyphColor} />
                  <Label style={[type.code, styles.entryName]} numberOfLines={1}>
                    {entry.name}
                    {isDir ? "/" : ""}
                  </Label>
                </Pressable>
                {isDir ? (
                  <Pressable
                    testID={`file-picker-insert-${entry.name}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Insert folder path ${entry.name}`}
                    onPress={() => {
                      const full = childPath(currentPath, entry.name);
                      const rel = relativePath(normCwd, full);
                      onSelect(`${rel}/`);
                    }}
                    style={({ pressed }) => [styles.insertBtn, pressed && styles.crumbPressed]}
                  >
                    <Label style={[type.label, styles.insertText]}>Select</Label>
                  </Pressable>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: ground.surface,
    borderRadius: radius.control,
    borderWidth: stroke.hair,
    borderColor: ground.edge,
    maxHeight: 240,
    marginBottom: space.snug,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.edge,
    backgroundColor: ground.raised,
  },
  breadcrumbsScroll: {
    flex: 1,
  },
  breadcrumbs: {
    flexDirection: "row",
    alignItems: "center",
  },
  crumbRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  crumbSep: {
    color: ink.faint,
    marginHorizontal: 4,
  },
  crumbBtn: {
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  crumbPressed: {
    backgroundColor: ground.active,
  },
  crumbText: {
    color: ink.muted,
  },
  crumbActive: {
    color: ink.bright,
  },
  closeBtn: {
    padding: 4,
    borderRadius: 4,
  },
  list: {
    maxHeight: 190,
  },
  empty: {
    padding: space.step,
    alignItems: "center",
  },
  emptyText: {
    color: ink.faint,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  itemPressed: {
    backgroundColor: ground.active,
  },
  entryMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    flex: 1,
    paddingVertical: 2,
  },
  entryName: {
    color: ink.bright,
    flex: 1,
  },
  insertBtn: {
    paddingHorizontal: space.snug,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: stroke.hair,
    borderColor: ground.edge,
  },
  insertText: {
    color: signal.working,
  },
});
