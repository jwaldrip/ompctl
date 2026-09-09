/**
 * The project filter picker.
 *
 * Replaces the horizontal row of 93 project chips with a single control in the
 * search row. Tapping the control opens a sheet on phones or a popover on
 * tablets, presenting projects sorted by most recent activity descending.
 *
 * The selected project renders as a single removable chip highlighted with
 * brand.azure rather than semantic signals (amber means working, azure means
 * selection).
 */

import type { GitProvider, ProviderRepo } from "@ompd/core/contracts";
import type { JSX } from "react";
import { useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  type PressableStateCallbackType,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Glyph } from "../design/icons.tsx";
import { useIsTablet } from "../design/layout.ts";
import { Body, Kicker, Label, Title } from "../design/text.tsx";
import { brand, ground, ink, radius, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { BrowserSession } from "../session/browser.ts";

/**
 * Maximum width of the picker surface when rendered as a popover on tablet.
 * Sized so paths up to four segments fit without horizontal scrolling while
 * remaining compact enough to read as an overlay rather than a modal sheet.
 */
const TABLET_POPOVER_MAX_WIDTH = 480;

/**
 * Maximum height of the picker list on tablets to maintain proportion with the viewport.
 */
const TABLET_POPOVER_MAX_HEIGHT = 520;

/**
 * Height of each project row in the picker list, providing a generous touch target.
 */
const PICKER_ROW_MIN_HEIGHT = TOUCH_TARGET;

export interface ProjectSummary {
  readonly cwd: string;
  readonly basename: string;
  readonly sessionCount: number;
  readonly lastActiveAt: string;
}

/**
 * Groups sessions by working directory and sorts projects descending by the most
 * recent lastActiveAt timestamp among their sessions.
 */
export function summarizeProjects(sessions: readonly BrowserSession[]): ProjectSummary[] {
  const map = new Map<string, { cwd: string; basename: string; sessionCount: number; lastActiveAt: string }>();

  for (const session of sessions) {
    if (!session.cwd) continue;
    const existing = map.get(session.cwd);
    if (!existing) {
      const parts = session.cwd.split("/").filter(Boolean);
      const basename = parts.pop() ?? session.cwd;
      map.set(session.cwd, {
        cwd: session.cwd,
        basename,
        sessionCount: 1,
        lastActiveAt: session.lastActiveAt,
      });
    } else {
      existing.sessionCount += 1;
      if (session.lastActiveAt > existing.lastActiveAt) {
        existing.lastActiveAt = session.lastActiveAt;
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const timeDiff = b.lastActiveAt.localeCompare(a.lastActiveAt);
    if (timeDiff !== 0) return timeDiff;
    return a.basename.localeCompare(b.basename);
  });
}

export interface ProjectPickerProps {
  sessions: readonly BrowserSession[];
  selectedProject: string | null;
  onSelectProject: (project: string | null) => void;
  /** Injected search query or initial filter for testing */
  initialQuery?: string;
  /** Force open state for testing */
  defaultOpen?: boolean;
}

export function ProjectPicker({
  sessions,
  selectedProject,
  onSelectProject,
  initialQuery = "",
  defaultOpen = false,
}: ProjectPickerProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState(initialQuery);
  const isTablet = useIsTablet();

  const allProjects = useMemo(() => summarizeProjects(sessions), [sessions]);

  const selectedSummary = useMemo(() => {
    if (selectedProject === null) return null;
    return (
      allProjects.find(p => p.cwd === selectedProject) ?? {
        cwd: selectedProject,
        basename: selectedProject.split("/").filter(Boolean).pop() ?? selectedProject,
        sessionCount: 0,
        lastActiveAt: "",
      }
    );
  }, [allProjects, selectedProject]);

  const filteredProjects = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return allProjects;
    return allProjects.filter(p => p.basename.toLowerCase().includes(trimmed) || p.cwd.toLowerCase().includes(trimmed));
  }, [allProjects, query]);

  const handleSelect = (cwd: string | null) => {
    onSelectProject(cwd);
    setOpen(false);
  };

  return (
    <View style={styles.container}>
      {selectedSummary === null ? (
        <Pressable
          testID="project-picker-trigger"
          accessibilityRole="button"
          accessibilityLabel="Filter by project: All projects"
          onPress={() => setOpen(true)}
          style={triggerStyle}
        >
          <Glyph name="folder" size={11} color={ink.muted} />
          <Kicker color={ink.muted}>All projects</Kicker>
          <Glyph name="chevron" size={9} color={ink.faint} />
        </Pressable>
      ) : (
        <View testID="project-chip-selected" style={styles.selectedChip}>
          <Pressable
            testID="project-picker-trigger"
            accessibilityRole="button"
            accessibilityLabel={`Filter by project: ${selectedSummary.basename}. Tap to change.`}
            onPress={() => setOpen(true)}
            style={selectedMainStyle}
          >
            <Glyph name="folder" size={11} color={brand.azure} />
            <Kicker color={brand.azure} numberOfLines={1}>
              {selectedSummary.basename}
            </Kicker>
          </Pressable>
          <Pressable
            testID="project-chip-clear"
            accessibilityRole="button"
            accessibilityLabel={`Clear project filter for ${selectedSummary.basename}`}
            onPress={() => onSelectProject(null)}
            style={selectedClearStyle}
          >
            <Glyph name="deny" size={9} color={brand.azure} />
          </Pressable>
        </View>
      )}

      {open ? (
        <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)}>
          <Pressable
            testID="project-picker-backdrop"
            accessibilityLabel="Close project picker"
            accessibilityRole="button"
            onPress={() => setOpen(false)}
            style={styles.backdrop}
          />
          <View
            testID={isTablet ? "project-picker-popover" : "project-picker-sheet"}
            style={isTablet ? styles.popoverSurface : styles.sheetSurface}
          >
            <View style={styles.header}>
              <View style={styles.searchBox} testID="project-picker-search-bar">
                <Glyph name="search" size={12} color={ink.faint} />
                <TextInput
                  testID="project-picker-search"
                  style={styles.searchInput}
                  placeholder="Filter projects..."
                  placeholderTextColor={ink.faint}
                  value={query}
                  onChangeText={setQuery}
                  accessibilityLabel="Filter projects"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                />
                {query.length > 0 ? (
                  <Pressable
                    testID="project-picker-search-clear"
                    accessibilityRole="button"
                    accessibilityLabel="Clear search"
                    onPress={() => setQuery("")}
                    style={styles.clearBtn}
                  >
                    <Glyph name="deny" size={10} color={ink.faint} />
                  </Pressable>
                ) : null}
              </View>
              <Pressable
                testID="project-picker-close"
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={() => setOpen(false)}
                style={closeBtnStyle}
              >
                <Glyph name="deny" size={12} color={ink.muted} />
              </Pressable>
            </View>

            <FlatList
              testID="project-picker-list"
              data={filteredProjects}
              keyExtractor={item => item.cwd}
              keyboardShouldPersistTaps="handled"
              style={styles.list}
              ListHeaderComponent={
                <Pressable
                  testID="project-picker-item-all"
                  accessibilityRole="button"
                  accessibilityLabel="All projects"
                  accessibilityState={{ selected: selectedProject === null }}
                  onPress={() => handleSelect(null)}
                  style={({ pressed }) => [
                    styles.row,
                    selectedProject === null && styles.rowSelected,
                    pressed && styles.rowPressed,
                  ]}
                >
                  <View style={styles.rowMain}>
                    <View style={styles.rowNameGroup}>
                      <Glyph name="folder" size={13} color={selectedProject === null ? brand.azure : ink.muted} />
                      <Body color={selectedProject === null ? brand.azure : ink.bright} numberOfLines={1}>
                        All projects
                      </Body>
                    </View>
                    <Label color={ink.faint} numberOfLines={1}>
                      Every session across the fleet
                    </Label>
                  </View>
                  <Kicker color={selectedProject === null ? brand.azure : ink.faint}>
                    {`${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`}
                  </Kicker>
                </Pressable>
              }
              renderItem={({ item }) => {
                const isSelected = selectedProject === item.cwd;
                return (
                  <Pressable
                    testID={`project-picker-item-${item.basename}`}
                    accessibilityRole="button"
                    accessibilityLabel={item.cwd}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => handleSelect(item.cwd)}
                    style={({ pressed }) => [
                      styles.row,
                      isSelected && styles.rowSelected,
                      pressed && styles.rowPressed,
                    ]}
                  >
                    <View style={styles.rowMain}>
                      <View style={styles.rowNameGroup}>
                        <Glyph name="folder" size={13} color={isSelected ? brand.azure : ink.muted} />
                        <Body color={isSelected ? brand.azure : ink.bright} numberOfLines={1}>
                          {item.basename}
                        </Body>
                      </View>
                      <Label color={ink.muted} numberOfLines={1}>
                        {item.cwd}
                      </Label>
                    </View>
                    <Kicker color={isSelected ? brand.azure : ink.faint}>
                      {`${item.sessionCount} ${item.sessionCount === 1 ? "session" : "sessions"}`}
                    </Kicker>
                  </Pressable>
                );
              }}
            />
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const triggerStyle = ({ pressed }: PressableStateCallbackType) => [styles.trigger, pressed && styles.triggerPressed];

const selectedMainStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.selectedMain,
  pressed && styles.triggerPressed,
];

const selectedClearStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.selectedClear,
  pressed && styles.triggerPressed,
];

const closeBtnStyle = ({ pressed }: PressableStateCallbackType) => [styles.closeBtn, pressed && styles.triggerPressed];

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    paddingHorizontal: space.snug,
    height: 30,
    borderRadius: radius.control,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    backgroundColor: ground.base,
  },
  triggerPressed: {
    backgroundColor: ground.active,
  },
  selectedChip: {
    flexDirection: "row",
    alignItems: "center",
    height: 30,
    borderRadius: radius.control,
    borderWidth: stroke.hair,
    borderColor: brand.azure,
    backgroundColor: ground.active,
  },
  selectedMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    paddingLeft: space.snug,
    paddingRight: space.tight,
    height: "100%",
  },
  selectedClear: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.tight,
    height: "100%",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(10, 12, 16, 0.7)",
  },
  sheetOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheetSurface: {
    backgroundColor: ground.surface,
    maxHeight: "85%",
    borderTopLeftRadius: radius.surface,
    borderTopRightRadius: radius.surface,
    borderTopWidth: stroke.hair,
    borderColor: ground.edge,
    overflow: "hidden",
  },
  popoverOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.step,
  },
  popoverSurface: {
    width: "100%",
    maxWidth: TABLET_POPOVER_MAX_WIDTH,
    maxHeight: TABLET_POPOVER_MAX_HEIGHT,
    backgroundColor: ground.surface,
    borderRadius: radius.surface,
    borderWidth: stroke.hair,
    borderColor: ground.edge,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.wide,
    paddingVertical: space.snug,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    height: 34,
    paddingHorizontal: space.snug,
    borderRadius: radius.control,
    backgroundColor: ground.base,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  searchInput: {
    flex: 1,
    color: ink.bright,
    fontSize: 13,
    paddingVertical: 0,
    paddingHorizontal: space.hair,
  },
  clearBtn: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  closeBtn: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  list: {
    flexGrow: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.snug,
    minHeight: PICKER_ROW_MIN_HEIGHT,
    paddingHorizontal: space.wide,
    paddingVertical: space.snug,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  rowSelected: {
    backgroundColor: ground.active,
    borderLeftWidth: 3,
    borderLeftColor: brand.azure,
  },
  rowPressed: {
    backgroundColor: ground.active,
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    gap: space.hair,
  },
  rowNameGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
});

export interface RepositoryPickerProps {
  /** Injected list of repositories, for testing or static feeds. */
  repos?: readonly ProviderRepo[];
  /** Whether a Git provider is connected. If false, falls back to URL entry. */
  connected?: boolean;
  /** Active provider, default "github". */
  provider?: GitProvider;
  /** Force open state for testing or inline render. */
  defaultOpen?: boolean;
  /** Render inline without Modal wrapper (for testing or embedding in screens). */
  inline?: boolean;
  initialQuery?: string;
  onSelectRepo?: (repo: ProviderRepo) => void;
  onSelectUrl?: (url: string) => void;
  onBack?: () => void;
}

export function RepositoryPicker({
  repos = [],
  connected = true,
  provider = "github",
  defaultOpen = false,
  inline = false,
  initialQuery = "",
  onSelectRepo,
  onSelectUrl,
  onBack,
}: RepositoryPickerProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState(initialQuery);
  const [urlMode, setUrlMode] = useState(!connected);
  const [manualUrl, setManualUrl] = useState("");
  const isTablet = useIsTablet();

  const filteredRepos = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      r =>
        r.name.toLowerCase().includes(q) ||
        r.fullName.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false),
    );
  }, [repos, query]);

  const showUrlInput = !connected || urlMode;

  const content = (
    <View
      testID={isTablet ? "repo-picker-popover" : "repo-picker-sheet"}
      style={isTablet ? styles.popoverSurface : styles.sheetSurface}
    >
      <View style={styles.header}>
        <View style={repoStyles.headerCopy}>
          <Kicker>
            {showUrlInput ? "Clone from URL" : `Clone from ${provider === "gitlab" ? "GitLab" : "GitHub"}`}
          </Kicker>
          <Title heading numberOfLines={1}>
            {showUrlInput ? "Enter repository URL" : "Choose a repository"}
          </Title>
        </View>
        <Pressable
          testID="repo-picker-close"
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={() => {
            setOpen(false);
            onBack?.();
          }}
          style={closeBtnStyle}
        >
          <Glyph name="deny" size={12} color={ink.muted} />
        </Pressable>
      </View>

      {showUrlInput ? (
        <View style={repoStyles.urlContainer} testID="repo-picker-url-fallback">
          <Label color={ink.muted} style={repoStyles.urlHelpText}>
            {!connected
              ? "No GitHub or GitLab account is connected. You can still clone any repository by pasting its URL."
              : "Paste the repository clone URL below."}
          </Label>
          <View style={repoStyles.urlInputRow}>
            <TextInput
              testID="repo-picker-url-input"
              style={repoStyles.urlInput}
              placeholder="git@github.com:you/repo.git"
              placeholderTextColor={ink.faint}
              value={manualUrl}
              onChangeText={setManualUrl}
              accessibilityLabel="Repository URL to clone"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              testID="repo-picker-url-submit"
              accessibilityRole="button"
              accessibilityState={{ disabled: manualUrl.trim().length === 0 }}
              disabled={manualUrl.trim().length === 0}
              onPress={() => {
                onSelectUrl?.(manualUrl.trim());
                setOpen(false);
              }}
              style={[repoStyles.urlSubmitBtn, manualUrl.trim().length === 0 && repoStyles.disabled]}
            >
              <Glyph name="repo" color={ink.inverse} size={12} />
              <Text style={repoStyles.urlSubmitText}>Clone URL</Text>
            </Pressable>
          </View>
          {connected ? (
            <Pressable
              testID="repo-picker-toggle-list"
              accessibilityRole="button"
              onPress={() => setUrlMode(false)}
              style={repoStyles.switchModeBtn}
            >
              <Label color={brand.azure}>Back to repository list</Label>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <>
          <View style={styles.searchBox} testID="repo-picker-search-bar">
            <Glyph name="search" size={12} color={ink.faint} />
            <TextInput
              testID="repo-picker-search"
              style={styles.searchInput}
              placeholder="Filter repositories..."
              placeholderTextColor={ink.faint}
              value={query}
              onChangeText={setQuery}
              accessibilityLabel="Filter repositories"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {query.length > 0 ? (
              <Pressable
                testID="repo-picker-search-clear"
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                onPress={() => setQuery("")}
                style={styles.clearBtn}
              >
                <Glyph name="deny" size={10} color={ink.faint} />
              </Pressable>
            ) : null}
          </View>

          <FlatList
            testID="repo-picker-list"
            data={filteredRepos}
            keyExtractor={item => item.id || item.fullName}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            ListFooterComponent={
              <Pressable
                testID="repo-picker-toggle-url"
                accessibilityRole="button"
                onPress={() => setUrlMode(true)}
                style={repoStyles.footerUrlBtn}
              >
                <Label color={brand.azure}>Paste a clone URL instead</Label>
              </Pressable>
            }
            renderItem={({ item }) => (
              <Pressable
                testID={`repo-picker-item-${item.name}`}
                accessibilityRole="button"
                accessibilityLabel={`${item.fullName}, ${item.isPrivate ? "private" : "public"}`}
                onPress={() => {
                  onSelectRepo?.(item);
                  setOpen(false);
                }}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <View style={styles.rowMain}>
                  <View style={styles.rowNameGroup}>
                    <Glyph name="repo" size={13} color={item.isPrivate ? brand.azure : ink.plain} />
                    <Body color={ink.bright} numberOfLines={1}>
                      {item.name}
                    </Body>
                    <Label color={item.isPrivate ? signal.holding : signal.ready} style={repoStyles.badge}>
                      {item.isPrivate ? "private" : "public"}
                    </Label>
                  </View>
                  {item.description ? (
                    <Label color={ink.muted} numberOfLines={1}>
                      {item.description}
                    </Label>
                  ) : null}
                  <View style={repoStyles.metaRow}>
                    <Kicker color={ink.faint}>{item.fullName}</Kicker>
                    <Label color={ink.faint}>•</Label>
                    <Label color={ink.faint}>{item.defaultBranch}</Label>
                  </View>
                </View>
                <Glyph name="chevron" size={11} color={ink.faint} />
              </Pressable>
            )}
          />
        </>
      )}
    </View>
  );

  if (inline) {
    return content;
  }

  return (
    <View style={styles.container}>
      {open ? (
        <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)}>
          <Pressable
            testID="repo-picker-backdrop"
            accessibilityLabel="Close repository picker"
            accessibilityRole="button"
            onPress={() => setOpen(false)}
            style={styles.backdrop}
          />
          {content}
        </Modal>
      ) : null}
    </View>
  );
}

export { RepositoryPicker as RepoPicker };

const repoStyles = StyleSheet.create({
  headerCopy: {
    flex: 1,
    gap: space.hair,
  },
  urlContainer: {
    padding: space.step,
    gap: space.snug,
  },
  urlHelpText: {
    marginBottom: space.hair,
  },
  urlInputRow: {
    flexDirection: "row",
    gap: space.snug,
    alignItems: "center",
  },
  urlInput: {
    flex: 1,
    height: TOUCH_TARGET,
    backgroundColor: ground.base,
    borderColor: ground.edge,
    borderWidth: stroke.hair,
    borderRadius: radius.control,
    paddingHorizontal: space.snug,
    color: ink.bright,
    ...type.body,
  },
  urlSubmitBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    backgroundColor: brand.azure,
    height: TOUCH_TARGET,
    paddingHorizontal: space.step,
    borderRadius: radius.control,
    justifyContent: "center",
  },
  urlSubmitText: {
    ...type.label,
    color: ink.inverse,
    fontWeight: "600",
  },
  disabled: {
    opacity: 0.45,
  },
  switchModeBtn: {
    paddingVertical: space.snug,
    alignItems: "center",
  },
  footerUrlBtn: {
    paddingVertical: space.step,
    alignItems: "center",
    borderTopColor: ground.line,
    borderTopWidth: stroke.hair,
  },
  badge: {
    fontSize: 10,
    textTransform: "uppercase",
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: ground.surface,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    marginTop: 2,
  },
});
