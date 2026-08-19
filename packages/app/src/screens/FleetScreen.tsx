/**
 * The session browser: every session this device has ever launched, unless
 * explicitly archived.
 *
 * Rows are sessions, not just live agents: a session nobody has touched today
 * is still a first-class row, because the point of a browser over a fleet is
 * finding the thing you are not currently looking at. Grouping by working
 * directory is the primary organiser, on the same reasoning the contract
 * states it: 93 groups over 305 sessions is unusable flat, and grouping is
 * what makes "which project was that in" answerable at a glance. A cwd is
 * data about a session here, a display grouping, never its identity.
 *
 * This screen is fully controlled. It owns no state of its own; `browser` is
 * the whole picture (sessions, sort, archive visibility, grouping, which
 * groups are collapsed) and every gesture becomes a callback. That is what
 * lets a canned `BrowserState` produce byte-identical markup to a live one,
 * the same discipline `console/state.ts` applies to the socket.
 */

import type { JSX } from "react";
import { useMemo } from "react";
import { FlatList, Pressable, SectionList, StyleSheet, View } from "react-native";
import { GroupHeader } from "../components/GroupHeader.tsx";
import { SessionRow } from "../components/SessionRow.tsx";
import { SortBar } from "../components/SortBar.tsx";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { BrowserSession, BrowserState, SortField } from "../session/browser.ts";
import { browserView } from "../session/browser.ts";

export interface FleetScreenProps {
  browser: BrowserState;
  onSort: (field: SortField) => void;
  onToggleGroup: (cwd: string) => void;
  onToggleGrouped: () => void;
  onToggleArchived: () => void;
  onOpen: (session: BrowserSession) => void;
  onArchive: (session: BrowserSession) => void;
  onUnarchive: (session: BrowserSession) => void;
  /** Injected so a test can pin the row clocks instead of racing the wall. */
  now?: number;
}

/**
 * Whether this row's open lands on the agent transcript (SessionScreen,
 * composer and all) rather than the terminal prompt surface. Mirrors the
 * ladder in `console/state.ts`: `live-ompd` attaches to its agent and
 * `dormant` rides the resume claim, both of which end on SessionScreen,
 * while `live-tui` is routed to TerminalSessionScreen, a screen with no
 * composer to drive. That distinction matters here because the status sort
 * puts live-tui rows FIRST (`STATUS_SEVERITY` ranks it 0 and `DEFAULT_SORT`
 * is status ascending), so the naive first row is exactly the row the path
 * scenario cannot use: it would open a terminal and then fail hunting for a
 * composer that screen never has. Archived rows are excluded too: they ride
 * the same resume claim, but the daemon's verifier refuses them, so their
 * open never reaches a transcript either.
 */
function opensAgentTranscript(session: BrowserSession): boolean {
  return session.status === "live-ompd" || session.status === "dormant";
}

export function FleetScreen({
  browser,
  onSort,
  onToggleGroup,
  onToggleGrouped,
  onToggleArchived,
  onOpen,
  onArchive,
  onUnarchive,
  now,
}: FleetScreenProps): JSX.Element {
  const view = useMemo(() => browserView(browser), [browser]);
  // Hoisted so the path marker below and the list read one traversal: the
  // rendered order is sections in order, collapsed groups contributing no
  // rows. Computing it a second, slightly different way is how a marker ends
  // up on a row a person cannot actually see.
  const sections = useMemo(
    () =>
      view.groups.map(group => ({
        cwd: group.cwd,
        group,
        data: browser.collapsedGroups.has(group.cwd) ? [] : group.sessions,
      })),
    [view, browser.collapsedGroups],
  );

  // The one row the committed path scenario opens by name, in the order the
  // active list actually draws. Undefined when no visible row opens a
  // transcript, and then no row carries the marker: the scenario failing to
  // find it is the honest result, not a bug to paper over.
  const rendered = browser.grouped ? sections.flatMap(section => section.data) : view.flatSessions;
  const firstPathId = rendered.find(opensAgentTranscript)?.id;

  // Virtualization's default `initialNumToRender` (10) is tuned for a feed a
  // person scrolls; a fleet browser is closer to a directory listing, and the
  // contract's own machine has 305 sessions across 93 groups. Rendering the
  // whole visible set eagerly is cheap at that scale and means a session is
  // never invisible to a search, a screen reader sweep, or a static render
  // that never fires the scroll/layout events which would otherwise grow the
  // window. React Native's virtualizer measures this in an estimated cell
  // count rather than a literal 1:1 slot count, so the multiplier here is an
  // empirically-checked safety margin, not the raw section+row total.
  const rows = view.visibleCount + view.groups.length;
  const initialNumToRender = rows * 2 + 50;

  return (
    <SafeScreen testID="fleet">
      <View style={styles.head}>
        <View style={styles.lead}>
          <Glyph name="bay" size={16} color={ink.plain} />
          <Display heading testID="fleet-title">
            Sessions
          </Display>
          <Kicker color={ink.muted} testID="fleet-count">
            {`${view.visibleCount} ${view.visibleCount === 1 ? "session" : "sessions"}`}
          </Kicker>
        </View>
        <Pressable
          testID="grouped-toggle"
          accessibilityRole="button"
          accessibilityState={{ selected: browser.grouped }}
          accessibilityLabel={browser.grouped ? "Grouped by directory" : "Flat list"}
          onPress={onToggleGrouped}
          style={({ pressed }) => [styles.toggle, pressed && { backgroundColor: ground.active }]}
        >
          <Glyph name="folder" size={12} color={browser.grouped ? signal.amber : ink.faint} />
        </Pressable>
        <Pressable
          testID="archived-toggle"
          accessibilityRole="button"
          accessibilityState={{ selected: browser.showArchived }}
          accessibilityLabel={
            browser.showArchived
              ? "Hide archived sessions"
              : `Show ${view.hiddenArchived} archived ${view.hiddenArchived === 1 ? "session" : "sessions"}`
          }
          onPress={onToggleArchived}
          style={({ pressed }) => [styles.toggle, pressed && { backgroundColor: ground.active }]}
        >
          <Glyph name="archive" size={12} color={browser.showArchived ? signal.amber : ink.faint} />
          {!browser.showArchived && view.hiddenArchived > 0 ? (
            <Label color={ink.faint} testID="archived-hidden-count">
              {view.hiddenArchived}
            </Label>
          ) : null}
        </Pressable>
      </View>

      <SortBar sort={browser.sort} onChange={onSort} />

      {browser.grouped ? (
        <SectionList
          testID="fleet-list"
          sections={sections}
          keyExtractor={(session: BrowserSession) => session.id}
          renderSectionHeader={({ section }) => (
            <GroupHeader
              group={section.group}
              collapsed={browser.collapsedGroups.has(section.cwd)}
              onToggle={onToggleGroup}
            />
          )}
          renderItem={({ item }: { item: BrowserSession }) => (
            <SessionRow
              session={item}
              showCwd={false}
              firstPathOpen={item.id === firstPathId}
              onOpen={onOpen}
              onArchive={onArchive}
              onUnarchive={onUnarchive}
              now={now}
            />
          )}
          stickySectionHeadersEnabled
          initialNumToRender={initialNumToRender}
          ListEmptyComponent={<Empty />}
        />
      ) : (
        <FlatList
          testID="fleet-list"
          data={view.flatSessions as BrowserSession[]}
          keyExtractor={session => session.id}
          renderItem={({ item }) => (
            <SessionRow
              session={item}
              showCwd
              firstPathOpen={item.id === firstPathId}
              onOpen={onOpen}
              onArchive={onArchive}
              onUnarchive={onUnarchive}
              now={now}
            />
          )}
          initialNumToRender={initialNumToRender}
          ListEmptyComponent={<Empty />}
        />
      )}
    </SafeScreen>
  );
}

function Empty(): JSX.Element {
  return (
    <View style={styles.empty} testID="fleet-empty">
      <Glyph name="bay" size={26} color={ground.edge} />
      <Body color={ink.plain}>No sessions.</Body>
      <Label color={ink.muted}>Start one with ompd agents create on the machine running the daemon.</Label>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.wide,
    paddingVertical: space.step,
    borderBottomWidth: stroke.heavy,
    borderBottomColor: ground.edge,
  },
  // The title block absorbs the header's slack, so the two controls after it
  // sit at the trailing content edge, flush with the action columns of the
  // rows below. With this group owning the slack, the head's gap is the only
  // spacing mechanism left in the strip, which is why `toggle` adds no margin
  // of its own.
  lead: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    justifyContent: "center",
  },
  empty: { alignItems: "center", gap: space.step, padding: space.gulf },
});
