/**
 * One agent's config: what this session offers and what it runs now.
 *
 * Config reads and writes ride the daemon's websocket directly, through
 * `agent_config_read` and `agent_config_write` frames answered by
 * `agent_config` events. One transport carries every pairing: direct and hub
 * connections both speak the socket, so a device paired over the relay
 * configures a session without needing HTTP routes or CORS headers. The
 * pairing token rides the socket handshake; it never leaves this device as
 * an HTTP bearer header.
 *
 * Every option the daemon advertises (mode, model, thinking) renders as a
 * picker. The model picker includes a filter field so an operator can find
 * a model without scrolling through hundreds of choices.
 *
 * No optimistic updates anywhere: the rows show what the daemon last
 * confirmed, a pending marker while a write is in flight, and the daemon's
 * own words beside the option when it refuses. A wrong model label on a
 * phone is worse than a slow one.
 */

import type { AgentConfigChoice, AgentConfigOption, AgentId } from "@ompd/core/contracts";
import { SCOPE_PROMPT, SCOPE_READ } from "@ompd/core/contracts";
import type { AgentConfigEvent, ClientErrorEvent } from "@ompd/core/ompd-client";
import { type JSX, useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Data, Kicker, Label, Title } from "../design/text.tsx";
import { brand, ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";

export type ConfigChoice = AgentConfigChoice;
export type ConfigOption = AgentConfigOption;

/** The slice of the console's client this screen rides; `OmpdClient` satisfies it as is. */
export interface AgentConfigClient {
  readAgentConfig(agentId: AgentId): void;
  writeAgentConfig(agentId: AgentId, optionId: string, value: string): void;
  on(event: "agent_config", listener: (event: AgentConfigEvent) => void): () => void;
  on(event: "error", listener: (event: ClientErrorEvent) => void): () => void;
}

/**
 * Groups options by category: the model first, then the mode, then thinking,
 * then anything else keeping wire order. A stable sort.
 */
function groupByCategory(options: readonly ConfigOption[]): Array<{ category: string; options: ConfigOption[] }> {
  const groups: Array<{ category: string; options: ConfigOption[] }> = [];
  for (const option of options) {
    const existing = groups.find(group => group.category === option.category);
    if (existing === undefined) {
      groups.push({ category: option.category, options: [option] });
    } else {
      existing.options.push(option);
    }
  }
  const rank = (category: string): number =>
    category === "model"
      ? 0
      : category === "mode"
        ? 1
        : category === "thought_level" || category === "thinking"
          ? 2
          : 3;
  return groups.toSorted((a, b) => rank(a.category) - rank(b.category));
}

/** A wire category id (`thought_level`) as the words an operator reads (`thought level`). */
function categoryLabel(category: string): string {
  return category.replace(/[_-]+/g, " ");
}

/** Cause and remedy for a refused read, in the operator's words rather than the wire's. */
function describeLoadRefusal(code: string | undefined, message?: string): string {
  if (code === "unauthorized" || code === "forbidden") {
    return "This device's pairing lacks the read scope, so the daemon will not serve this screen. Pair it again with read to configure sessions from here.";
  }
  if (code === "unknown_agent") {
    return "The daemon no longer knows this agent. Close this screen and reopen the session.";
  }
  if (code === "no_session") {
    return "This agent has no live session behind it, so there is no config to read.";
  }
  if (code === "config_unavailable") {
    return "The daemon has no config surface for this session right now. Retry once it has one.";
  }
  if (message !== undefined && message.length > 0) {
    return message;
  }
  return "The daemon refused to read the config.";
}

/** Cause and remedy for a refused change, same rule as the read. */
function describePostRefusal(code: string | null | undefined, message: string): string {
  if (code === "unauthorized") {
    return "This device's pairing lacks the prompt scope, so the daemon refuses to change this session's configuration. Pair it again with prompt to set it from here.";
  }
  if (code === "unknown_mode" || code === "unknown_option" || code === "unknown_value") {
    return "That choice is not one this session offers. The list changed under this screen; reload it and pick again.";
  }
  if (code === "unknown_agent") {
    return "The daemon no longer knows this agent, so the setting was not changed.";
  }
  if (code === "no_session") {
    return "This agent has no live session behind it, so the setting was not changed.";
  }
  if (code === "config_unavailable") {
    return "The daemon has no config surface for this session right now, so the setting was not changed.";
  }
  return message;
}

type Phase = { kind: "loading" } | { kind: "refused"; reason: string } | { kind: "ready"; options: ConfigOption[] };

export interface AgentConfigScreenProps {
  agentId: AgentId;
  /** The agent's display name, for the header. The route works without it. */
  agentName?: string;
  connection: Connection;
  /**
   * The scopes the daemon's hello last reported for this device, undefined
   * until a daemon that reports them has answered. The stored pairing's
   * scopes stand in until then, optimistic when the pairing declared none,
   * the same three-way rule `canInvite` follows: an older pairing must not
   * have its controls vanish against a daemon that would allow them.
   */
  grantedScopes?: readonly string[];
  /**
   * The console's socket client, so this screen opens no second link: the
   * frames it needs ride the one the session already holds.
   */
  client: AgentConfigClient;
  onBack: () => void;
}

export function AgentConfigScreen(props: AgentConfigScreenProps): JSX.Element {
  const { agentId, connection } = props;

  const effectiveScopes = props.grantedScopes ?? (connection.scopes.length === 0 ? undefined : connection.scopes);
  const canRead = effectiveScopes === undefined ? true : effectiveScopes.includes(SCOPE_READ);
  const canSet = effectiveScopes === undefined ? true : effectiveScopes.includes(SCOPE_PROMPT);

  const unreachable = canRead
    ? null
    : "This device's pairing holds no read scope, so the daemon will not serve this screen its config. Pair it again with read to configure a session from here.";

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  /** The option and choice value a write is carrying, null when none is out. */
  const [pending, setPending] = useState<{ optionId: string; value: string } | null>(null);
  const [postRefusal, setPostRefusal] = useState<string | null>(null);
  const [optionErrors, setOptionErrors] = useState<Record<string, string>>({});
  const [lastAttempt, setLastAttempt] = useState<{ optionId: string; value: string; name: string } | null>(null);

  const client = props.client;

  const load = useCallback(() => {
    if (!canRead) return;
    setPhase({ kind: "loading" });
    client.readAgentConfig(agentId);
  }, [agentId, canRead, client]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const unsubConfig = client.on("agent_config", event => {
      if (event.agentId !== agentId) return;
      setPhase({ kind: "ready", options: event.configOptions });
      setPending(null);
      setPostRefusal(null);
      setOptionErrors({});
    });

    const unsubError = client.on("error", event => {
      if (event.agentId !== undefined && event.agentId !== agentId) return;

      setPhase(current => {
        if (current.kind === "loading") {
          return {
            kind: "refused",
            reason: describeLoadRefusal(event.code, event.message),
          };
        }
        return current;
      });

      setPending(currentPending => {
        if (currentPending !== null) {
          const refused = describePostRefusal(event.code, event.message);
          setPostRefusal(refused);
          setOptionErrors(prev => ({
            ...prev,
            [currentPending.optionId]: event.message,
          }));
        }
        return null;
      });
    });

    return () => {
      unsubConfig();
      unsubError();
    };
  }, [agentId, client]);

  const choose = useCallback(
    (optionId: string, value: string, name: string): void => {
      if (!canRead || !canSet) return;
      if (pending !== null || phase.kind !== "ready") return;
      const option = phase.options.find(opt => opt.id === optionId);
      if (option === undefined || option.currentValue === value) return;

      setPending({ optionId, value });
      setLastAttempt({ optionId, value, name });
      setPostRefusal(null);
      setOptionErrors(prev => {
        const next = { ...prev };
        delete next[optionId];
        return next;
      });

      client.writeAgentConfig(agentId, optionId, value);
    },
    [agentId, canRead, canSet, client, pending, phase],
  );

  const retryLast = useCallback(() => {
    if (lastAttempt === null) return;
    choose(lastAttempt.optionId, lastAttempt.value, lastAttempt.name);
  }, [choose, lastAttempt]);

  return (
    <SafeScreen edges={{ top: true, bottom: false, left: true, right: true }} testID="agent-config">
      <View style={styles.head}>
        <Pressable
          testID="agent-config-back"
          accessibilityRole="button"
          accessibilityLabel="Back to the session"
          onPress={props.onBack}
          style={({ pressed }) => [styles.back, pressed && { backgroundColor: ground.active }]}
        >
          <Glyph name="back" size={14} color={ink.plain} />
          <Label color={ink.plain} testID="agent-config-back-label">
            Session
          </Label>
        </Pressable>
        <View style={styles.ident}>
          <Title heading numberOfLines={1} testID="agent-config-title">
            {props.agentName ?? "Session config"}
          </Title>
          <Label color={ink.muted} numberOfLines={1}>
            Mode, model and thinking
          </Label>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {unreachable !== null ? (
          <View style={styles.state} testID="agent-config-unreachable">
            <Glyph name="warning" size={16} color={ink.muted} />
            <Label color={ink.muted}>{unreachable}</Label>
          </View>
        ) : phase.kind === "loading" ? (
          <View style={styles.state} testID="agent-config-loading">
            <Label color={ink.muted}>Reading this session's config...</Label>
          </View>
        ) : phase.kind === "refused" ? (
          <View style={styles.state} testID="agent-config-load-failure">
            <Glyph name="warning" size={16} color={signal.failed} />
            <Label color={ink.bright}>{phase.reason}</Label>
            <Pressable
              testID="agent-config-load-retry"
              accessibilityRole="button"
              accessibilityLabel="Retry reading the config"
              onPress={load}
              style={({ pressed }) => [styles.retry, pressed && { backgroundColor: ground.active }]}
            >
              <Kicker color={ink.plain}>Retry</Kicker>
            </Pressable>
          </View>
        ) : (
          <>
            {postRefusal === null || pending !== null ? null : (
              <View style={styles.banner} testID="agent-config-post-failure">
                <Label color={ink.bright}>{postRefusal}</Label>
                <Pressable
                  testID="agent-config-post-retry"
                  accessibilityRole="button"
                  accessibilityLabel="Retry the change"
                  onPress={retryLast}
                  style={({ pressed }) => [styles.retry, pressed && { backgroundColor: ground.active }]}
                >
                  <Kicker color={ink.plain}>Retry</Kicker>
                </Pressable>
              </View>
            )}
            {groupByCategory(phase.options).map(group => (
              <View key={group.category} style={styles.group} testID={`agent-config-group-${group.category}`}>
                <Kicker color={ink.muted}>{categoryLabel(group.category)}</Kicker>
                {group.options.map(option => (
                  <ConfigOptionBlock
                    key={option.id}
                    canSet={canSet}
                    option={option}
                    pending={pending}
                    error={optionErrors[option.id]}
                    onChoose={choose}
                  />
                ))}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SafeScreen>
  );
}

/**
 * One option and its choices. The reason a row will not act is stated once
 * under the rows rather than repeated per row: it is a fact about the option,
 * not about each choice.
 */
function ConfigOptionBlock({
  option,
  canSet,
  pending,
  error,
  onChoose,
}: {
  option: ConfigOption;
  canSet: boolean;
  pending: { optionId: string; value: string } | null;
  error?: string;
  onChoose: (optionId: string, value: string, name: string) => void;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  const current = option.options.find(choice => choice.value === option.currentValue) ?? null;

  let reason: string | null = null;
  if (!canSet) {
    reason = "Changing this setting needs the prompt scope, which this device's pairing does not hold.";
  }

  const normalizedFilter = filter.trim().toLowerCase();
  const visibleChoices =
    option.id === "model" && normalizedFilter.length > 0
      ? option.options.filter(
          choice =>
            choice.name.toLowerCase().includes(normalizedFilter) ||
            choice.value.toLowerCase().includes(normalizedFilter),
        )
      : option.options;

  return (
    <View style={styles.option} testID={`agent-config-option-${option.id}`}>
      <View style={styles.optionHead}>
        <Title numberOfLines={1}>{option.name}</Title>
        <Data color={ink.muted}>{current?.name ?? option.currentValue}</Data>
      </View>
      {option.id === "model" ? (
        <TextInput
          testID="agent-config-filter-model"
          accessibilityLabel="Filter models"
          placeholder="Filter models"
          placeholderTextColor={ink.faint}
          value={filter}
          onChangeText={setFilter}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.filterInput}
        />
      ) : null}
      {visibleChoices.map(choice => {
        const active = choice.value === option.currentValue;
        const applying = pending !== null && pending.optionId === option.id && pending.value === choice.value;
        const enabled = canSet && pending === null && !active;
        return (
          <Pressable
            key={choice.value}
            testID={`agent-config-choice-${option.id}-${choice.value}`}
            accessibilityRole="button"
            accessibilityLabel={`${option.name}: ${choice.name}`}
            accessibilityState={{ disabled: !enabled, selected: active }}
            disabled={!enabled}
            onPress={() => {
              onChoose(option.id, choice.value, choice.name);
            }}
            style={({ pressed }) => [styles.choice, pressed && enabled && { backgroundColor: ground.active }]}
          >
            <View style={styles.choiceText}>
              <Label color={enabled ? ink.plain : ink.muted}>{choice.name}</Label>
              {choice.description === undefined ? null : <Label color={ink.faint}>{choice.description}</Label>}
            </View>
            {active ? (
              <View style={styles.marker}>
                <Glyph name="allow" size={12} color={brand.azure} />
                <Kicker color={brand.azure} testID={`agent-config-current-${option.id}`}>
                  Current
                </Kicker>
              </View>
            ) : applying ? (
              <Kicker color={signal.working} testID="agent-config-pending">
                Applying
              </Kicker>
            ) : null}
          </Pressable>
        );
      })}
      {error !== undefined ? (
        <View testID={`agent-config-option-${option.id}-error`}>
          <Label color={signal.failed} style={styles.reason} testID={`agent-config-option-${option.id}-reason`}>
            {error}
          </Label>
        </View>
      ) : reason !== null ? (
        <Label color={ink.muted} style={styles.reason} testID={`agent-config-option-${option.id}-reason`}>
          {reason}
        </Label>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  back: {
    minHeight: TOUCH_TARGET,
    minWidth: TOUCH_TARGET,
    paddingHorizontal: space.snug,
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  ident: {
    flex: 1,
    gap: space.hair,
  },
  body: {
    padding: space.step,
    gap: space.step,
  },
  group: {
    gap: space.snug,
  },
  option: {
    borderTopWidth: stroke.hair,
    borderTopColor: ground.line,
  },
  optionHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.snug,
    paddingVertical: space.snug,
  },
  filterInput: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
    color: ink.bright,
    backgroundColor: ground.surface,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    marginBottom: space.snug,
  },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    minHeight: TOUCH_TARGET,
    paddingVertical: space.tight,
  },
  choiceText: {
    flex: 1,
    gap: space.hair,
  },
  marker: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  reason: {
    paddingVertical: space.tight,
  },
  state: {
    padding: space.wide,
    gap: space.snug,
  },
  banner: {
    borderWidth: stroke.hair,
    borderColor: signal.failed,
    padding: space.step,
    gap: space.snug,
  },
  retry: {
    alignSelf: "flex-start",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.wide,
    alignItems: "center",
    justifyContent: "center",
  },
});
