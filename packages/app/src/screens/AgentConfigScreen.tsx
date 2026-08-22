/**
 * One agent's config: what this session offers and what it runs now.
 *
 * The daemon serves this over HTTP (`GET` and `POST` on
 * `/v1/agents/:id/config`), which fixes two honest limits the screen states
 * rather than hides:
 *
 *  - The hub tunnels exactly one request shape today, a webhook fire, and no
 *    tunnel is wired for `/v1/agents/:id/config`, so from behind the relay
 *    these routes are unreachable. Generalising that tunnel is the thing not
 *    being done: a proxied config read would carry this device's bearer token
 *    through the hub, making the hub a credential path rather than a carrier
 *    of opaque sealed traffic. The screen says so instead of guessing at a
 *    root, the same fail-closed rule Cowork's fetches follow.
 *  - The POST changes exactly one option, the session mode, and the daemon
 *    validates the value against that option's own choices. Every other
 *    option, the model included, reads back its live current value while its
 *    choices carry the reason they cannot be set from here, because a control
 *    that vanishes teaches the operator the feature does not exist.
 *
 * No optimistic updates anywhere: the rows show what the daemon last
 * confirmed, a pending marker while a POST is out, and the daemon's own
 * words when it refuses. A wrong model label on a phone is worse than a
 * slow one.
 */

import type { AgentId } from "@ompd/core/contracts";
import { SCOPE_PROMPT, SCOPE_READ } from "@ompd/core/contracts";
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { restRoot } from "../cowork/useCowork.ts";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Data, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";

/**
 * The one option the daemon's POST accepts. Mirrors the gateway's
 * `MODE_OPTION_ID`, which the app cannot import across the daemon's package
 * edge; if the route ever grows a field for another option, this is the
 * single place that learns it.
 */
const SETTABLE_OPTION_ID = "mode";

/** One choice inside an option, as the daemon reports it. Mirrors the daemon's `SessionConfigChoice` behind its package edge. */
interface ConfigChoice {
  value: string;
  name: string;
  description?: string;
}

/** One config option, as `GET /v1/agents/:id/config` reports it. Mirrors the daemon's `SessionConfigOption`. */
interface ConfigOption {
  id: string;
  name: string;
  /** Groups related options, e.g. `mode` or `model`. */
  category: string;
  currentValue: string;
  options: ConfigChoice[];
}

/**
 * Groups options by category, the model first. The model is what the operator
 * came to check, so it leads; the mode, the one option this route can set,
 * follows; anything else keeps its wire order behind them. A stable sort, so
 * equal ranks never shuffle what the daemon sent.
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
  const rank = (category: string): number => (category === "model" ? 0 : category === SETTABLE_OPTION_ID ? 1 : 2);
  return groups.toSorted((a, b) => rank(a.category) - rank(b.category));
}

/**
 * Read one config body off the wire, or say it is not one. The daemon builds
 * this shape itself, but a daemon this app has not met yet might not, and a
 * screen that rendered a half-parsed option would show controls that lie
 * about what they can do.
 */
function parseConfig(raw: unknown): ConfigOption[] | null {
  if (raw === null || typeof raw !== "object") return null;
  const body = raw as { configOptions?: unknown };
  if (!Array.isArray(body.configOptions)) return null;
  const options: ConfigOption[] = [];
  for (const entry of body.configOptions) {
    if (entry === null || typeof entry !== "object") return null;
    const option = entry as Record<string, unknown>;
    if (
      typeof option.id !== "string" ||
      typeof option.name !== "string" ||
      typeof option.category !== "string" ||
      typeof option.currentValue !== "string" ||
      !Array.isArray(option.options)
    ) {
      return null;
    }
    const choices: ConfigChoice[] = [];
    for (const rawChoice of option.options) {
      if (rawChoice === null || typeof rawChoice !== "object") return null;
      const choice = rawChoice as Record<string, unknown>;
      if (typeof choice.value !== "string" || typeof choice.name !== "string") return null;
      choices.push({
        value: choice.value,
        name: choice.name,
        description: typeof choice.description === "string" ? choice.description : undefined,
      });
    }
    options.push({
      id: option.id,
      name: option.name,
      category: option.category,
      currentValue: option.currentValue,
      options: choices,
    });
  }
  return options;
}

/** The daemon's own `error` code, when its refusal carried one. */
async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/** Cause and remedy for a refused read, in the operator's words rather than the wire's. */
function describeLoadRefusal(status: number): string {
  if (status === 403) {
    return "This device's pairing lacks the read scope, so the daemon will not serve this screen. Pair it again with read to configure sessions from here.";
  }
  if (status === 404) {
    return "The daemon no longer knows this agent. Close this screen and reopen the session.";
  }
  if (status === 409) {
    return "This agent has no live session behind it, so there is no config to read.";
  }
  if (status === 503) {
    return "The daemon has no config surface for this session right now. Retry once it has one.";
  }
  return `The daemon refused to read the config (HTTP ${status}).`;
}

/** Cause and remedy for a refused change, same rule as the read. */
function describePostRefusal(status: number, code: string | null): string {
  if (status === 403) {
    return "This device's pairing lacks the prompt scope, so the daemon refuses to change this session's mode. Pair it again with prompt to set it from here.";
  }
  if (code === "unknown_mode") {
    return "That mode is not one this session offers. The list changed under this screen; reload it and pick again.";
  }
  if (status === 404) {
    return "The daemon no longer knows this agent, so the mode was not changed.";
  }
  if (status === 409) {
    return "This agent has no live session behind it, so the mode was not changed.";
  }
  if (status === 503) {
    return "The daemon has no config surface for this session right now, so the mode was not changed.";
  }
  if (status === 502) {
    return code === null ? "The agent refused to change its mode." : `The agent refused to change its mode: ${code}.`;
  }
  return `The daemon refused with HTTP ${status}${code === null ? "" : ` (${code})`}; the mode was not changed.`;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
  onBack: () => void;
}

export function AgentConfigScreen(props: AgentConfigScreenProps): JSX.Element {
  const { agentId, connection } = props;

  const effectiveScopes = props.grantedScopes ?? (connection.scopes.length === 0 ? undefined : connection.scopes);
  const canRead = effectiveScopes === undefined ? true : effectiveScopes.includes(SCOPE_READ);
  const canSet = effectiveScopes === undefined ? true : effectiveScopes.includes(SCOPE_PROMPT);

  // The config routes are plain REST on the socket url's origin, and only a
  // direct pairing has one: the hub carries no tunnel for these routes, so
  // this fails closed rather than guessing at a root.
  const root = connection.transport === "direct" ? restRoot(connection.url) : null;
  const unreachable =
    connection.transport === "hub"
      ? "Config is served by the daemon's own HTTP routes, and this pairing reaches the daemon through the hub, which carries no route for them. Pair this device directly, on the daemon's network, to configure a session."
      : root === null
        ? "This pairing's url is not a socket address, so there is no HTTP root to read the daemon's config from."
        : canRead
          ? null
          : "This device's pairing holds no read scope, so the daemon will not serve this screen its config. Pair it again with read to configure a session from here.";

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  /** The choice value a POST is carrying, null when none is out. */
  const [pending, setPending] = useState<string | null>(null);
  const [postRefusal, setPostRefusal] = useState<string | null>(null);
  /** The last attempted change, so its retry re-sends the same body. */
  const [lastAttempt, setLastAttempt] = useState<{ value: string; name: string } | null>(null);

  // Answers are matched to the ask that produced them. A retry or a unmount
  // between request and response would otherwise let a slow refusal clobber
  // the state a newer answer already replaced.
  const loadSeq = useRef(0);
  const postSeq = useRef(0);

  const load = useCallback((): void => {
    if (root === null || !canRead) return;
    loadSeq.current += 1;
    const seq = loadSeq.current;
    setPhase({ kind: "loading" });
    void (async () => {
      try {
        const response = await fetch(`${root}/v1/agents/${agentId}/config`, {
          headers: { Authorization: `Bearer ${connection.token}` },
        });
        if (!response.ok) {
          if (seq !== loadSeq.current) return;
          setPhase({ kind: "refused", reason: describeLoadRefusal(response.status) });
          return;
        }
        const options = parseConfig(await response.json());
        if (seq !== loadSeq.current) return;
        if (options === null) {
          setPhase({ kind: "refused", reason: "The daemon's answer was not a config this screen can read." });
          return;
        }
        setPhase({ kind: "ready", options });
      } catch (cause) {
        if (seq !== loadSeq.current) return;
        setPhase({ kind: "refused", reason: `The config could not be read: ${describeCause(cause)}` });
      }
    })();
  }, [root, canRead, agentId, connection.token]);

  useEffect(() => {
    load();
  }, [load]);

  const choose = useCallback(
    (value: string, name: string): void => {
      if (root === null || !canRead || !canSet) return;
      if (pending !== null || phase.kind !== "ready") return;
      const mode = phase.options.find(option => option.id === SETTABLE_OPTION_ID);
      // The active row is already the daemon's answer; re-sending it would be
      // a POST that cannot change anything but can still fail.
      if (mode === undefined || mode.currentValue === value) return;

      postSeq.current += 1;
      const seq = postSeq.current;
      setPending(value);
      setLastAttempt({ value, name });
      setPostRefusal(null);
      void (async () => {
        try {
          const response = await fetch(`${root}/v1/agents/${agentId}/config`, {
            method: "POST",
            headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ modeId: value }),
          });
          if (!response.ok) {
            const code = await errorCode(response);
            if (seq !== postSeq.current) return;
            setPostRefusal(describePostRefusal(response.status, code));
            setPending(null);
            return;
          }
          const options = parseConfig(await response.json());
          if (seq !== postSeq.current) return;
          setPending(null);
          if (options === null) {
            setPostRefusal(
              "The daemon changed the mode but its answer was not a config this screen can read. Reload it.",
            );
            return;
          }
          setPhase({ kind: "ready", options });
        } catch (cause) {
          if (seq !== postSeq.current) return;
          setPostRefusal(`The mode was not changed: ${describeCause(cause)}`);
          setPending(null);
        }
      })();
    },
    [root, canRead, canSet, pending, phase, agentId, connection.token],
  );

  const retryLast = useCallback((): void => {
    if (lastAttempt === null) return;
    choose(lastAttempt.value, lastAttempt.name);
  }, [lastAttempt, choose]);

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
            Mode and model
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
            <Glyph name="warning" size={16} color={signal.oxide} />
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
                <Kicker color={ink.muted}>{group.category}</Kicker>
                {group.options.map(option => (
                  <ConfigOptionBlock
                    key={option.id}
                    canSet={canSet}
                    option={option}
                    pending={pending}
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
  onChoose,
}: {
  option: ConfigOption;
  canSet: boolean;
  pending: string | null;
  onChoose: (value: string, name: string) => void;
}): JSX.Element {
  const settable = option.id === SETTABLE_OPTION_ID;
  const current = option.options.find(choice => choice.value === option.currentValue) ?? null;

  let reason: string | null = null;
  if (!settable) {
    reason = "This remote changes the session mode only. Set this from the agent itself.";
  } else if (!canSet) {
    reason = "Changing the mode needs the prompt scope, which this device's pairing does not hold.";
  }

  return (
    <View style={styles.option} testID={`agent-config-option-${option.id}`}>
      <View style={styles.optionHead}>
        <Title numberOfLines={1}>{option.name}</Title>
        <Data color={ink.muted}>{current?.name ?? option.currentValue}</Data>
      </View>
      {option.options.map(choice => {
        const active = choice.value === option.currentValue;
        // Scoped to the settable option: a value that happens to match on
        // another option's row is a coincidence of strings, not this change.
        const applying = settable && pending !== null && choice.value === pending;
        const enabled = settable && canSet && pending === null && !active;
        return (
          <Pressable
            key={choice.value}
            testID={`agent-config-choice-${option.id}-${choice.value}`}
            accessibilityRole="button"
            accessibilityLabel={`${option.name}: ${choice.name}`}
            accessibilityState={{ disabled: !enabled, selected: active }}
            disabled={!enabled}
            onPress={() => {
              onChoose(choice.value, choice.name);
            }}
            style={({ pressed }) => [styles.choice, pressed && enabled && { backgroundColor: ground.active }]}
          >
            <View style={styles.choiceText}>
              <Label color={enabled ? ink.plain : ink.muted}>{choice.name}</Label>
              {choice.description === undefined ? null : <Label color={ink.faint}>{choice.description}</Label>}
            </View>
            {active ? (
              <View style={styles.marker}>
                <Glyph name="allow" size={12} color={ink.bright} />
                <Kicker color={ink.bright} testID={`agent-config-current-${option.id}`}>
                  Current
                </Kicker>
              </View>
            ) : applying ? (
              <Kicker color={ink.muted} testID="agent-config-pending">
                Applying
              </Kicker>
            ) : null}
          </Pressable>
        );
      })}
      {reason === null ? null : (
        <Label color={ink.muted} style={styles.reason} testID={`agent-config-option-${option.id}-reason`}>
          {reason}
        </Label>
      )}
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
    borderBottomWidth: stroke.heavy,
  },
  // Labeled on purpose, the same rule the session header's back follows: an
  // icon alone under a thumb is how an operator ends up somewhere they did
  // not mean to go.
  back: {
    minHeight: TOUCH_TARGET,
    minWidth: TOUCH_TARGET,
    paddingHorizontal: space.snug,
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  ident: { flex: 1, gap: space.hair },
  body: { padding: space.step, gap: space.step },
  group: { gap: space.snug },
  option: { borderTopWidth: stroke.hair, borderTopColor: ground.line },
  optionHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.snug,
    paddingVertical: space.snug,
  },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    minHeight: TOUCH_TARGET,
    paddingVertical: space.tight,
  },
  choiceText: { flex: 1, gap: space.hair },
  marker: { flexDirection: "row", alignItems: "center", gap: space.tight },
  reason: { paddingVertical: space.tight },
  state: { padding: space.wide, gap: space.snug },
  banner: {
    borderWidth: stroke.hair,
    borderColor: signal.oxide,
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
