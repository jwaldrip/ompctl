/**
 * The three catalogue views: skills to invoke, connectors to check, plugins
 * that group them. Each is a thin composition over `cowork/catalog.ts`'s pure
 * functions — grouping, health, search all decided there; these lay out the
 * result.
 */

import type { JSX, ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import type { PluginGroup } from "../cowork/catalog.ts";
import { connectorHealth, groupByPlugin, ORIGIN_LABELS } from "../cowork/catalog.ts";
import type { ConnectorSummary, SkillSummary } from "../cowork/types.ts";
import type { GlyphName } from "../design/icons.tsx";
import { Glyph } from "../design/icons.tsx";
import { Body, Data, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke } from "../design/tokens.ts";
import { ConnectorRow } from "./ConnectorRow.tsx";
import { PluginBadge } from "./PluginBadge.tsx";
import { SkillCard } from "./SkillCard.tsx";

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillsViewProps {
  skills: readonly SkillSummary[];
  onInvoke: (skill: SkillSummary) => void;
  refusal?: string | null;
  status?: string;
}

export function SkillsView({ skills, onInvoke, refusal, status }: SkillsViewProps): JSX.Element {
  const isRefused = status === "refused" || (refusal !== null && refusal !== undefined);
  const isLoading = status === "loading";
  return (
    <ScrollView testID="skills-view" contentContainerStyle={styles.list}>
      <Head
        glyph="skill"
        count={skills.length}
        noun="skill"
        emptyLabel={isRefused ? "Skills unavailable" : isLoading ? "Loading skills..." : "No skills installed"}
        testID="skills-count"
      />
      {isRefused ? (
        <View style={styles.refused} testID="cowork-skills-refused">
          <Glyph name="warning" color={signal.holding} size={13} />
          <Label color={signal.holding} style={styles.refusedText}>
            {refusal ?? "The daemon refused the skills catalogue."}
          </Label>
        </View>
      ) : isLoading && skills.length === 0 ? (
        <View style={styles.loading} testID="cowork-skills-loading">
          <Label color={ink.muted}>Loading skills...</Label>
        </View>
      ) : skills.length === 0 ? (
        <Empty
          glyph="skill"
          title="No skills installed."
          hint="A skill lives under skills/ in a plugin or an OMP config directory."
        />
      ) : (
        skills.map(skill => (
          <SkillCard key={`${skill.kind}:${skill.name}:${skill.source}`} skill={skill} onInvoke={onInvoke} />
        ))
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

export interface ConnectorsViewProps {
  connectors: readonly ConnectorSummary[];
  refusal?: string | null;
  status?: string;
}

export function ConnectorsView({ connectors, refusal, status }: ConnectorsViewProps): JSX.Element {
  const isRefused = status === "refused" || (refusal !== null && refusal !== undefined);
  const isLoading = status === "loading";
  const health = connectorHealth(connectors);

  return (
    <ScrollView testID="connectors-view" contentContainerStyle={styles.list}>
      <Head
        glyph="connector"
        count={connectors.length}
        noun="connector"
        emptyLabel={
          isRefused ? "Connectors unavailable" : isLoading ? "Loading connectors..." : "No connectors installed"
        }
        testID="connectors-count"
      />
      {isRefused ? (
        <View style={styles.refused} testID="cowork-connectors-refused">
          <Glyph name="warning" color={signal.holding} size={13} />
          <Label color={signal.holding} style={styles.refusedText}>
            {refusal ?? "The daemon refused the connectors catalogue."}
          </Label>
        </View>
      ) : isLoading && connectors.length === 0 ? (
        <View style={styles.loading} testID="cowork-connectors-loading">
          <Label color={ink.muted}>Loading connectors...</Label>
        </View>
      ) : connectors.length === 0 ? (
        <Empty
          glyph="connector"
          title="No connectors installed."
          hint="Wire one in .mcp.json or a plugin's own config."
        />
      ) : (
        <>
          {health.down.length > 0 ? (
            <Section label={`Needs attention (${health.down.length})`}>
              {health.down.map(connector => (
                <ConnectorRow key={connector.name} connector={connector} />
              ))}
            </Section>
          ) : null}
          {health.connected.length > 0 ? (
            <Section label={`Connected (${health.connected.length})`}>
              {health.connected.map(connector => (
                <ConnectorRow key={connector.name} connector={connector} />
              ))}
            </Section>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export interface PluginsViewProps {
  skills: readonly SkillSummary[];
  connectors: readonly ConnectorSummary[];
  skillsRefusal?: string | null;
  connectorsRefusal?: string | null;
  status?: string;
  skillsStatus?: string;
  connectorsStatus?: string;
}

export function PluginsView({
  skills,
  connectors,
  skillsRefusal,
  connectorsRefusal,
  status,
  skillsStatus,
  connectorsStatus,
}: PluginsViewProps): JSX.Element {
  const groups = groupByPlugin(skills, connectors);
  const isRefused = Boolean(skillsRefusal || connectorsRefusal);
  const isLoading = status === "loading" || skillsStatus === "loading" || connectorsStatus === "loading";

  return (
    <ScrollView testID="plugins-view" contentContainerStyle={styles.list}>
      <Head
        glyph="plugin"
        count={groups.length}
        noun="plugin"
        emptyLabel={isRefused ? "Plugins unavailable" : isLoading ? "Loading plugins..." : "No plugins installed"}
        testID="plugins-count"
      />
      {isRefused ? (
        <View style={styles.refused} testID="cowork-plugins-refused">
          <Glyph name="warning" color={signal.holding} size={13} />
          <Label color={signal.holding} style={styles.refusedText}>
            {[
              skillsRefusal ? `Skills: ${skillsRefusal}` : null,
              connectorsRefusal ? `Connectors: ${connectorsRefusal}` : null,
            ]
              .filter(Boolean)
              .join(". ")}
          </Label>
        </View>
      ) : isLoading && groups.length === 0 ? (
        <View style={styles.loading} testID="cowork-plugins-loading">
          <Label color={ink.muted}>Loading plugins...</Label>
        </View>
      ) : groups.length === 0 ? (
        <Empty glyph="plugin" title="No plugins installed." />
      ) : (
        groups.map(group => <PluginGroupCard key={group.key} group={group} />)
      )}
    </ScrollView>
  );
}

function PluginGroupCard({ group }: { group: PluginGroup }): JSX.Element {
  return (
    <View style={styles.group} testID={`plugin-group-${group.key}`}>
      <View style={styles.groupHead}>
        <PluginBadge origin={group.origin} label={group.label} testID={`plugin-group-${group.key}-badge`} />
        <Label color={ink.muted}>{ORIGIN_LABELS[group.origin]}</Label>
        {(() => {
          const counts: string[] = [];
          if (group.skills.length > 0) {
            counts.push(`${group.skills.length} skill${group.skills.length === 1 ? "" : "s"}`);
          }
          if (group.connectors.length > 0) {
            counts.push(`${group.connectors.length} connector${group.connectors.length === 1 ? "" : "s"}`);
          }
          const text = counts.join(" · ");
          return text.length > 0 ? (
            <Data color={ink.faint} style={styles.groupCounts}>
              {text}
            </Data>
          ) : null;
        })()}
      </View>
      {group.skills.map(skill => (
        <SkillRow key={`${skill.kind}:${skill.name}:${skill.source}`} skill={skill} />
      ))}
      {group.connectors.map(connector => (
        <ConnectorNameRow key={connector.name} connector={connector} />
      ))}
    </View>
  );
}

/** A skill inside its plugin group: name and kind only — the group already carries provenance, so `SkillCard`'s own badge would repeat it. */
function SkillRow({ skill }: { skill: SkillSummary }): JSX.Element {
  return (
    <View style={styles.memberRow} testID={`plugin-group-skill-${skill.name}`}>
      <Glyph name={skill.kind === "command" ? "commands" : "skill"} size={11} color={ink.faint} />
      <Label color={ink.plain} numberOfLines={1}>{`/${skill.name}`}</Label>
    </View>
  );
}

function ConnectorNameRow({ connector }: { connector: ConnectorSummary }): JSX.Element {
  return (
    <View style={styles.memberRow} testID={`plugin-group-connector-${connector.name}`}>
      <Glyph name="connector" size={11} color={ink.faint} />
      <Label color={ink.plain} numberOfLines={1}>
        {connector.name}
      </Label>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function Head({
  glyph,
  count,
  noun,
  testID,
  emptyLabel,
}: {
  glyph: GlyphName;
  count: number;
  noun: string;
  testID: string;
  emptyLabel?: string;
}): JSX.Element {
  const label = count === 0 ? (emptyLabel ?? `No ${noun}s installed`) : `${count} ${count === 1 ? noun : `${noun}s`}`;
  return (
    <View style={styles.head}>
      <Glyph name={glyph} size={16} color={ink.plain} />
      <Kicker color={ink.muted} testID={testID}>
        {label}
      </Kicker>
    </View>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <View>
      <Kicker color={ink.muted} style={styles.sectionLabel}>
        {label}
      </Kicker>
      {children}
    </View>
  );
}

function Empty({ glyph, title, hint }: { glyph: GlyphName; title: string; hint?: string }): JSX.Element {
  return (
    <View style={styles.empty}>
      <Glyph name={glyph} size={22} color={ground.edge} />
      <Body color={ink.plain}>{title}</Body>
      {hint !== undefined ? <Label color={ink.muted}>{hint}</Label> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.wide,
    paddingVertical: space.step,
    borderBottomWidth: stroke.heavy,
    borderBottomColor: ground.edge,
  },
  sectionLabel: { paddingHorizontal: space.wide, paddingTop: space.step, paddingBottom: space.tight, letterSpacing: 1 },
  empty: { alignItems: "center", gap: space.step, padding: space.gulf },
  loading: { alignItems: "center", gap: space.step, padding: space.gulf },
  refused: {
    alignItems: "center",
    backgroundColor: ground.surface,
    borderColor: signal.holding,
    borderWidth: stroke.hair,
    flexDirection: "row",
    gap: space.snug,
    padding: space.snug,
    margin: space.wide,
  },
  refusedText: { flex: 1 },
  group: { borderBottomWidth: stroke.heavy, borderBottomColor: ground.edge, paddingVertical: space.step },
  groupHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.wide,
    paddingBottom: space.snug,
  },
  groupCounts: { marginLeft: "auto" },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    paddingHorizontal: space.wide,
    paddingVertical: space.tight,
  },
});
