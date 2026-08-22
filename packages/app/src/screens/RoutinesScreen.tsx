import { type RemoteRoutine, type Run, SCOPE_MANAGE, SCOPE_PROMPT, type TriggerSpec } from "@ompd/core/contracts";
import { CronError, nextFireTime } from "@ompd/core/cron";
import type { OmpdClient } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { createOmpdClient } from "../console/useConsole.ts";
import { restRoot } from "../cowork/useCowork.ts";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Code, Display, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, signalWash, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";

type RoutineStatus =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; routines: RemoteRoutine[]; runs: Run[] };

/** The schedule the editor arms first: daily at 09:00 UTC, chosen over the
 * phone's zone because it is the same reading for every operator who opens it. */
const DEFAULT_CRON: TriggerSpec = { kind: "cron", expression: "0 9 * * *", timezone: "UTC" };
const DEFAULT_INTERVAL_SECONDS = 3600;

/** Interval units offered in human terms; the contract stores plain seconds. */
const INTERVAL_UNITS = { seconds: 1, minutes: 60, hours: 3600, days: 86400 } as const;
const INTERVAL_LABELS: Record<IntervalUnit, string> = {
  seconds: "Seconds",
  minutes: "Minutes",
  hours: "Hours",
  days: "Days",
};
type IntervalUnit = keyof typeof INTERVAL_UNITS;

function mintId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function newRoutine(): RemoteRoutine {
  const id = mintId("rtn");
  return {
    id,
    name: "Routine",
    enabled: true,
    trigger: { ...DEFAULT_CRON },
    actions: [
      {
        id: mintId("act"),
        name: "Action 1",
        prompt: "",
        cwd: "",
        labels: {},
      },
    ],
    singleton: false,
    labels: {},
    createdAt: new Date().toISOString(),
  };
}

/** The honest spelling of stored seconds at card width: `1h 30m`, never `5400s`. */
function describeSeconds(total: number): string {
  const units: Array<[string, number]> = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1],
  ];
  const parts: string[] = [];
  let rest = total;
  for (const [name, size] of units) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count}${name}`);
      rest -= count * size;
    }
  }
  return parts.length > 0 ? parts.join(" ") : "0s";
}

function describeTrigger(trigger: TriggerSpec): string {
  if (trigger.kind === "cron") {
    const zone = trigger.timezone === undefined || trigger.timezone === "" ? "" : ` ${trigger.timezone}`;
    return `Scheduled, ${trigger.expression}${zone}`;
  }
  if (trigger.kind === "interval") return `Scheduled, every ${describeSeconds(trigger.seconds)}`;
  return trigger.kind === "webhook" ? "Webhook trigger" : "Manual trigger";
}

/**
 * The address a caller actually POSTs to fire this routine.
 *
 * A hub pairing has a real answer here, which is why this is not a shrug at
 * the operator. The hub tunnels `POST /v1/webhooks/<daemonId>/<routineId>`
 * down the daemon's already-open sealed socket as a `webhook_request`, waits
 * for the daemon's `webhook_response`, and replays it as a real HTTP
 * response, routing across hub instances on the way. So a routine on a
 * laptop behind NAT is firable from anywhere without that laptop publishing
 * a port, and the phone holds both halves of the address already.
 *
 * The daemon's own route takes one segment because it serves exactly one
 * daemon. The hub's takes two because it has to be told which.
 */
function webhookEndpoint(connection: Connection, routineId: string): string {
  if (connection.transport === "hub") {
    const hub = restRoot(connection.hubUrl);
    const authority = hub ?? "{hub address}";
    return `POST ${authority}/v1/webhooks/${connection.daemonId}/${routineId}`;
  }
  const root = restRoot(connection.url);
  return `POST ${root ?? "{daemon address}"}/v1/webhooks/${routineId}`;
}

/**
 * The interval editor holds text a person is still typing, not the number the
 * contract wants, so a half-typed value never snaps to something else. This is
 * the read-back: the largest unit that divides the stored seconds exactly.
 */
function deriveInterval(seconds: number): { text: string; unit: IntervalUnit } {
  for (const unit of ["days", "hours", "minutes", "seconds"] as const) {
    const size = INTERVAL_UNITS[unit];
    if (seconds >= size && seconds % size === 0) return { text: String(seconds / size), unit };
  }
  return { text: "1", unit: "hours" };
}

/** One calendar reading, fixed format across every ICU the app runs on. */
function formatFireTime(date: Date, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      dateStyle: "short",
      timeStyle: "short",
      hourCycle: "h23",
      timeZone: timezone,
    }).format(date);
  } catch {
    // Hermes without full ICU must still show a reading, not a crash.
    return date.toISOString();
  }
}

/** The zone a preview is computed in: the trigger's own when it names one. */
function previewZone(timezone: string | undefined): string {
  const trimmed = timezone?.trim() ?? "";
  return trimmed !== "" ? trimmed : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

type NextFirePreview =
  | { error?: undefined; fire: Date; zone: string; suffix: string }
  | { error: string; fire?: undefined; zone?: undefined; suffix?: undefined }
  | null;

/** What a card can say about a stored schedule, computed with the same function the daemon arms it with. */
function nextFirePreview(trigger: TriggerSpec, now: Date): NextFirePreview {
  if (trigger.kind === "cron") {
    const trimmed = trigger.timezone?.trim() ?? "";
    const timezone = trimmed === "" ? undefined : trimmed;
    try {
      return {
        fire: nextFireTime(trigger.expression, now, timezone),
        zone: previewZone(trimmed === "" ? undefined : trimmed),
        suffix: timezone === undefined ? "" : ` (${timezone})`,
      };
    } catch (cause) {
      return { error: cause instanceof CronError ? cause.message : String(cause) };
    }
  }
  if (trigger.kind === "interval" && Number.isFinite(trigger.seconds) && trigger.seconds > 0) {
    return {
      fire: new Date(now.getTime() + trigger.seconds * 1000),
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      suffix: "",
    };
  }
  return null;
}

export function RoutinesScreen({
  connection,
  onBack,
  createClient = createOmpdClient,
}: {
  connection: Connection;
  onBack: () => void;
  createClient?: (connection: Connection) => OmpdClient;
}): JSX.Element {
  const canManage = connection.scopes.includes(SCOPE_MANAGE);
  const canRun = canManage && connection.scopes.includes(SCOPE_PROMPT);
  const [status, setStatus] = useState<RoutineStatus>({ kind: "loading" });
  const [draft, setDraft] = useState<RemoteRoutine | null>(null);
  const [intervalEdit, setIntervalEdit] = useState(() => deriveInterval(DEFAULT_INTERVAL_SECONDS));
  const [pending, setPending] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ routineId: string; value: string } | null>(null);
  const clientRef = useRef<OmpdClient | null>(null);
  if (clientRef.current === null) clientRef.current = createClient(connection);
  const client = clientRef.current;

  useEffect(() => {
    const offs = [
      client.on("status", event => {
        if (event.state === "connected") client.readRoutines();
      }),
      client.on("routines", event => {
        setPending(null);
        setStatus({ kind: "ready", routines: event.routines, runs: event.runs });
      }),
      client.on("routine_ran", event => {
        setPending(null);
        setStatus(current => {
          if (current.kind !== "ready") return current;
          return {
            ...current,
            runs: [event.run, ...current.runs.filter(run => run.id !== event.run.id)],
          };
        });
      }),
      client.on("routine_secret", event => {
        setPending(null);
        setSecret({ routineId: event.routineId, value: event.secret });
      }),
      client.on("error", event => {
        setPending(null);
        setStatus(current => (current.kind === "loading" ? { kind: "failed", message: event.message } : current));
      }),
    ];
    client.start();
    return () => {
      for (const off of offs) off();
      client.close();
    };
  }, [client]);

  const retry = useCallback(() => {
    setStatus({ kind: "loading" });
    client.readRoutines();
  }, [client]);

  const updateAction = useCallback((index: number, field: "name" | "prompt" | "cwd", value: string) => {
    setDraft(current => {
      if (current === null) return null;
      return {
        ...current,
        actions: current.actions.map((action, actionIndex) =>
          actionIndex === index ? { ...action, [field]: value } : action,
        ),
      };
    });
  }, []);

  const setTriggerKind = useCallback(
    (kind: "schedule" | "webhook" | "manual") => {
      if (draft === null) return;
      // A kind switch is a deliberate edit, but never one that throws away a
      // secret the operator cannot read back: the plaintext exists only at mint.
      let trigger: TriggerSpec;
      if (kind === "schedule") {
        trigger =
          draft.trigger.kind === "cron" || draft.trigger.kind === "interval" ? draft.trigger : { ...DEFAULT_CRON };
      } else if (kind === "webhook") {
        trigger = draft.trigger.kind === "webhook" ? draft.trigger : { kind: "webhook", secretRef: mintId("whsec") };
      } else {
        trigger = { kind: "manual" };
      }
      setDraft({ ...draft, trigger });
    },
    [draft],
  );

  const setScheduleShape = useCallback(
    (shape: "cron" | "interval") => {
      if (draft === null) return;
      if (shape === "cron") {
        const trigger = draft.trigger.kind === "cron" ? draft.trigger : { ...DEFAULT_CRON };
        setDraft({ ...draft, trigger });
        return;
      }
      const trigger: TriggerSpec =
        draft.trigger.kind === "interval" ? draft.trigger : { kind: "interval", seconds: DEFAULT_INTERVAL_SECONDS };
      setIntervalEdit(deriveInterval(trigger.seconds));
      setDraft({ ...draft, trigger });
    },
    [draft],
  );

  const applyIntervalText = useCallback(
    (text: string) => {
      setIntervalEdit(current => ({ ...current, text }));
      const value = Number(text.trim());
      const seconds =
        text.trim() === "" || !Number.isFinite(value) ? 0 : Math.round(value * INTERVAL_UNITS[intervalEdit.unit]);
      setDraft(current =>
        current !== null && current.trigger.kind === "interval"
          ? { ...current, trigger: { kind: "interval", seconds } }
          : current,
      );
    },
    [intervalEdit.unit],
  );

  const applyIntervalUnit = useCallback(
    (unit: IntervalUnit) => {
      setIntervalEdit(current => ({ ...current, unit }));
      const value = Number(intervalEdit.text.trim());
      const seconds =
        intervalEdit.text.trim() === "" || !Number.isFinite(value) ? 0 : Math.round(value * INTERVAL_UNITS[unit]);
      setDraft(current =>
        current !== null && current.trigger.kind === "interval"
          ? { ...current, trigger: { kind: "interval", seconds } }
          : current,
      );
    },
    [intervalEdit],
  );

  const setDraftFromRoutine = useCallback((routine: RemoteRoutine) => {
    setDraft({ ...routine, actions: routine.actions.map(action => ({ ...action })) });
    if (routine.trigger.kind === "interval") setIntervalEdit(deriveInterval(routine.trigger.seconds));
  }, []);

  /**
   * One pass over the draft trigger, because the error and the preview must
   * agree: both come from the daemon's own `nextFireTime`, so an expression
   * that cannot arm on the daemon cannot be saved from here either.
   */
  const triggerCheck = useMemo<{ error: string | null; fire: Date | null; zone: string; suffix: string }>(() => {
    if (draft === null) return { error: null, fire: null, zone: "", suffix: "" };
    const trigger = draft.trigger;
    if (trigger.kind === "cron") {
      const trimmed = trigger.timezone?.trim() ?? "";
      const timezone = trimmed === "" ? undefined : trimmed;
      try {
        return {
          error: null,
          fire: nextFireTime(trigger.expression, new Date(), timezone),
          zone: previewZone(timezone),
          suffix: timezone === undefined ? "" : ` (${timezone})`,
        };
      } catch (cause) {
        return {
          error: cause instanceof CronError ? cause.message : `Cannot read this schedule: ${String(cause)}`,
          fire: null,
          zone: "",
          suffix: "",
        };
      }
    }
    if (trigger.kind === "interval") {
      const seconds = trigger.seconds;
      if (!Number.isFinite(seconds) || seconds < 1) {
        return { error: `Interval needs a positive duration, got ${seconds}`, fire: null, zone: "", suffix: "" };
      }
      return {
        error: null,
        fire: new Date(Date.now() + seconds * 1000),
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        suffix: "",
      };
    }
    return { error: null, fire: null, zone: "", suffix: "" };
  }, [draft]);

  const saveBlocked =
    draft !== null && (triggerCheck.error !== null || draft.actions.some(action => action.cwd.trim() === ""));

  const save = useCallback(() => {
    if (!canManage || draft === null || draft.actions.length === 0) return;
    // Refused here as well as disabled in the control: a gate that only exists
    // in markup is a gate one accessibility path away from being gone.
    if (triggerCheck.error !== null) return;
    if (draft.actions.some(action => action.cwd.trim() === "")) return;
    setPending(`save:${draft.id}`);
    client.writeRoutine(draft);
    setDraft(null);
  }, [canManage, client, draft, triggerCheck.error]);

  const ready = status.kind === "ready" ? status : null;

  return (
    <SafeScreen style={styles.screen} testID="routines-screen">
      <View style={styles.header}>
        <Kicker color={ink.muted}>Automation</Kicker>
        <Display heading>Routines</Display>
        <Body color={ink.plain}>One trigger can run several agent actions, in the order shown.</Body>
      </View>

      {!canManage ? (
        <View style={styles.notice} testID="routines-readonly-notice">
          <Label color={signal.ochre}>
            This pairing can read routines but not change or run them: it holds no manage scope.
          </Label>
        </View>
      ) : !canRun ? (
        <View style={styles.notice} testID="routines-run-disabled-notice">
          <Label color={signal.ochre}>
            This pairing can edit routines but cannot run them: it holds no prompt scope.
          </Label>
        </View>
      ) : null}

      {status.kind === "loading" ? (
        <View style={styles.centered}>
          <ActivityIndicator color={ink.plain} />
        </View>
      ) : status.kind === "failed" ? (
        <View style={styles.notice} testID="routines-read-error">
          <Label color={signal.oxide}>Could not read routines: {status.message}</Label>
          <Pressable accessibilityRole="button" onPress={retry} style={styles.smallButton} testID="routines-retry">
            <Label color={signal.sage}>Try again</Label>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {ready?.routines.length === 0 ? (
            <Body color={ink.muted} testID="routines-empty">
              No routines are configured on this daemon.
            </Body>
          ) : null}
          {ready?.routines.map(routine => {
            const latest = ready.runs.find(run => run.routineId === routine.id);
            const armed = nextFirePreview(routine.trigger, new Date());
            return (
              <View key={routine.id} style={styles.card} testID={`routine-${routine.id}`}>
                <View style={styles.cardHeader}>
                  <View style={styles.copy}>
                    <Title>{routine.name}</Title>
                    <Label color={ink.muted}>{describeTrigger(routine.trigger)}</Label>
                  </View>
                  <Label color={routine.enabled ? signal.sage : ink.faint}>{routine.enabled ? "On" : "Off"}</Label>
                </View>

                {armed !== null ? (
                  armed.error !== undefined ? (
                    <Label color={signal.oxide}>Schedule unreadable: {armed.error}</Label>
                  ) : (
                    <Body color={ink.muted} testID={`routine-${routine.id}-next-fire`}>
                      {`Next fire ${formatFireTime(armed.fire, armed.zone)}${armed.suffix}`}
                    </Body>
                  )
                ) : null}

                {routine.actions.map((action, index) => {
                  const outcome = latest?.actions.find(candidate => candidate.actionId === action.id);
                  const failure = outcome?.refusal?.reason ?? outcome?.error;
                  return (
                    <View key={action.id} style={styles.action} testID={`routine-${routine.id}-action-${action.id}`}>
                      <View style={styles.actionOrder}>
                        <Label color={ink.muted}>{index + 1}</Label>
                      </View>
                      <View style={styles.copy}>
                        <Label color={ink.plain}>{action.name}</Label>
                        <Body color={failure === undefined ? ink.muted : signal.oxide}>
                          {failure ?? outcome?.state ?? "Not run yet"}
                        </Body>
                      </View>
                    </View>
                  );
                })}

                <View style={styles.controls}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !canManage }}
                    disabled={!canManage}
                    onPress={() => setDraftFromRoutine(routine)}
                    style={styles.smallButton}
                    testID={`routine-${routine.id}-edit`}
                  >
                    <Glyph name="edit" size={13} color={canManage ? ink.plain : ink.faint} />
                    <Label color={canManage ? ink.plain : ink.faint}>Edit</Label>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !canRun || pending !== null }}
                    disabled={!canRun || pending !== null}
                    onPress={() => {
                      setPending(`run:${routine.id}`);
                      client.runRoutine(routine.id);
                    }}
                    style={styles.smallButton}
                    testID={`routine-${routine.id}-run`}
                  >
                    <Glyph name="resume" size={13} color={canRun ? signal.sage : ink.faint} />
                    <Label color={canRun ? signal.sage : ink.faint}>Run</Label>
                  </Pressable>
                  {routine.trigger.kind === "webhook" ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: !canManage || pending !== null }}
                      disabled={!canManage || pending !== null}
                      onPress={() => {
                        setPending(`secret:${routine.id}`);
                        setSecret(null);
                        client.rotateRoutineSecret(routine.id);
                      }}
                      style={styles.smallButton}
                      testID={`routine-${routine.id}-rotate-secret`}
                    >
                      <Glyph name="link" size={13} color={canManage ? ink.plain : ink.faint} />
                      <Label color={canManage ? ink.plain : ink.faint}>Rotate secret</Label>
                    </Pressable>
                  ) : null}
                </View>

                {secret?.routineId === routine.id ? (
                  <View style={styles.secret} testID="routine-secret-value">
                    <Kicker color={signal.ochre}>Shown once</Kicker>
                    <Body color={ink.plain}>{secret.value}</Body>
                  </View>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
      )}

      {draft === null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canManage }}
          disabled={!canManage}
          onPress={() => setDraft(newRoutine())}
          style={styles.primaryButton}
          testID="routines-new"
        >
          <Glyph name="newTask" size={14} color={canManage ? ground.base : ink.faint} />
          <Kicker color={canManage ? ground.base : ink.faint}>New routine</Kicker>
        </Pressable>
      ) : (
        <ScrollView contentContainerStyle={styles.editor} testID="routine-editor">
          <Kicker color={ink.muted}>Routine</Kicker>
          <TextInput
            accessibilityLabel="Routine name"
            onChangeText={name => setDraft(current => (current === null ? null : { ...current, name }))}
            placeholder="Routine name"
            placeholderTextColor={ink.faint}
            style={styles.input}
            testID="routine-editor-name"
            value={draft.name}
          />

          <Kicker color={ink.muted}>Trigger</Kicker>
          <View style={styles.optionRow}>
            {(
              [
                { choice: "schedule", testID: "routine-trigger-schedule", label: "Schedule", glyph: "plan" },
                { choice: "webhook", testID: "routine-trigger-webhook", label: "Webhook", glyph: "link" },
                { choice: "manual", testID: "routine-trigger-manual", label: "Manual", glyph: "resume" },
              ] as const
            ).map(option => {
              const kindChoice =
                draft.trigger.kind === "cron" || draft.trigger.kind === "interval" ? "schedule" : draft.trigger.kind;
              const selected = kindChoice === option.choice;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={option.choice}
                  onPress={() => setTriggerKind(option.choice)}
                  style={[styles.option, selected ? styles.optionSelected : null]}
                  testID={option.testID}
                >
                  <Glyph name={option.glyph} size={13} color={selected ? signal.sage : ink.muted} />
                  <Label color={selected ? signal.sage : ink.muted}>{option.label}</Label>
                </Pressable>
              );
            })}
          </View>

          {draft.trigger.kind === "cron" || draft.trigger.kind === "interval" ? (
            <View style={styles.triggerSection} testID="routine-schedule-editor">
              <View style={styles.optionRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: draft.trigger.kind === "cron" }}
                  onPress={() => setScheduleShape("cron")}
                  style={[styles.option, draft.trigger.kind === "cron" ? styles.optionSelected : null]}
                  testID="routine-schedule-cron"
                >
                  <Label color={draft.trigger.kind === "cron" ? signal.sage : ink.muted}>At times</Label>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: draft.trigger.kind === "interval" }}
                  onPress={() => setScheduleShape("interval")}
                  style={[styles.option, draft.trigger.kind === "interval" ? styles.optionSelected : null]}
                  testID="routine-schedule-interval"
                >
                  <Label color={draft.trigger.kind === "interval" ? signal.sage : ink.muted}>Every</Label>
                </Pressable>
              </View>

              {draft.trigger.kind === "cron" ? (
                <>
                  <TextInput
                    accessibilityLabel="Cron expression"
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={value =>
                      setDraft(current =>
                        current !== null && current.trigger.kind === "cron"
                          ? { ...current, trigger: { ...current.trigger, expression: value } }
                          : current,
                      )
                    }
                    placeholder="Five fields, minute through weekday: 0 9 * * *"
                    placeholderTextColor={ink.faint}
                    style={styles.input}
                    testID="routine-cron-expression"
                    value={draft.trigger.expression}
                  />
                  <TextInput
                    accessibilityLabel="Cron timezone"
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={value =>
                      setDraft(current =>
                        current !== null && current.trigger.kind === "cron"
                          ? {
                              ...current,
                              trigger: {
                                kind: "cron",
                                expression: current.trigger.expression,
                                timezone: value.trim() === "" ? undefined : value.trim(),
                              },
                            }
                          : current,
                      )
                    }
                    placeholder="Timezone, e.g. America/New_York"
                    placeholderTextColor={ink.faint}
                    style={styles.input}
                    testID="routine-cron-timezone"
                    value={draft.trigger.timezone ?? ""}
                  />
                  <Label color={ink.muted}>
                    An empty timezone means the daemon's own zone; the preview below reads this phone's.
                  </Label>
                </>
              ) : (
                <>
                  <TextInput
                    accessibilityLabel="Interval duration"
                    keyboardType="numeric"
                    onChangeText={applyIntervalText}
                    placeholder="30"
                    placeholderTextColor={ink.faint}
                    style={styles.input}
                    testID="routine-interval-value"
                    value={intervalEdit.text}
                  />
                  <View style={styles.optionRow}>
                    {(Object.keys(INTERVAL_UNITS) as IntervalUnit[]).map(unit => (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: intervalEdit.unit === unit }}
                        key={unit}
                        onPress={() => applyIntervalUnit(unit)}
                        style={[styles.option, intervalEdit.unit === unit ? styles.optionSelected : null]}
                        testID={`routine-interval-unit-${unit}`}
                      >
                        <Label color={intervalEdit.unit === unit ? signal.sage : ink.muted}>
                          {INTERVAL_LABELS[unit]}
                        </Label>
                      </Pressable>
                    ))}
                  </View>
                </>
              )}

              {triggerCheck.error === null && triggerCheck.fire !== null ? (
                <Body color={ink.plain} testID="routine-next-fire">
                  {`Next fire ${formatFireTime(triggerCheck.fire, triggerCheck.zone)}${triggerCheck.suffix}`}
                </Body>
              ) : null}
            </View>
          ) : null}

          {draft.trigger.kind === "webhook" ? (
            <View style={styles.triggerSection} testID="routine-webhook-editor">
              <Kicker color={ink.muted}>Endpoint</Kicker>
              <Code testID="routine-webhook-endpoint">{webhookEndpoint(connection, draft.id)}</Code>
              {connection.transport === "hub" ? (
                <Body color={ink.muted} testID="routine-webhook-hub-notice">
                  That address is the hub's, and it works: the hub relays the fire down this daemon's sealed socket and
                  answers with the daemon's own reply, so nothing has to reach the daemon's network and the daemon needs
                  no open port. Any caller holding the current secret can POST there. The hub reads that secret in order
                  to forward it, so it is the one credential this routine hands out; rotate it from this routine's card
                  after saving.
                </Body>
              ) : (
                <Body color={ink.muted}>
                  Any caller that can reach this daemon's address and holds the current secret can POST here. Rotate the
                  secret from this routine's card after saving.
                </Body>
              )}
            </View>
          ) : null}

          {draft.trigger.kind === "manual" ? (
            <View style={styles.triggerSection} testID="routine-manual-editor">
              <Body color={ink.muted}>
                Nothing on a clock arms this routine: it runs only when started by hand, from this screen's Run control
                or the CLI.
              </Body>
            </View>
          ) : null}

          {triggerCheck.error !== null ? (
            <View style={styles.triggerError} testID="routine-trigger-error">
              <Glyph name="warning" size={13} color={signal.oxide} />
              <Label color={signal.oxide}>{triggerCheck.error}</Label>
            </View>
          ) : null}

          {draft.actions.map((action, index) => (
            <View key={action.id} style={styles.editorAction} testID={`routine-editor-action-${index}`}>
              <Kicker color={ink.muted}>Action {index + 1}</Kicker>
              <TextInput
                accessibilityLabel={`Action ${index + 1} name`}
                onChangeText={value => updateAction(index, "name", value)}
                placeholder="Action name"
                placeholderTextColor={ink.faint}
                style={styles.input}
                testID={`routine-action-${index}-name`}
                value={action.name}
              />
              <TextInput
                accessibilityLabel={`Action ${index + 1} prompt`}
                multiline
                onChangeText={value => updateAction(index, "prompt", value)}
                placeholder="What this action should do"
                placeholderTextColor={ink.faint}
                style={[styles.input, styles.promptInput]}
                testID={`routine-action-${index}-prompt`}
                value={action.prompt}
              />
              <TextInput
                accessibilityLabel={`Action ${index + 1} working directory`}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={value => updateAction(index, "cwd", value)}
                placeholder="Working directory, e.g. /Users/me/dev/project"
                placeholderTextColor={ink.faint}
                style={styles.input}
                testID={`routine-action-${index}-cwd`}
                value={action.cwd}
              />
              {action.cwd.trim() === "" ? (
                <Label color={signal.oxide} testID={`routine-action-${index}-cwd-error`}>
                  A working directory is required: the daemon cannot run an action that has none.
                </Label>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: draft.actions.length === 1 }}
                disabled={draft.actions.length === 1}
                onPress={() =>
                  setDraft(current =>
                    current === null
                      ? null
                      : {
                          ...current,
                          actions: current.actions.filter((_candidate, actionIndex) => actionIndex !== index),
                        },
                  )
                }
                style={styles.smallButton}
                testID={`routine-action-${index}-remove`}
              >
                <Glyph name="delete" size={13} color={draft.actions.length === 1 ? ink.faint : signal.oxide} />
                <Label color={draft.actions.length === 1 ? ink.faint : signal.oxide}>Remove</Label>
              </Pressable>
            </View>
          ))}
          <View style={styles.controls}>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                setDraft(current =>
                  current === null
                    ? null
                    : {
                        ...current,
                        actions: [
                          ...current.actions,
                          {
                            id: mintId("act"),
                            name: `Action ${current.actions.length + 1}`,
                            prompt: "",
                            cwd: "",
                            labels: {},
                          },
                        ],
                      },
                )
              }
              style={styles.smallButton}
              testID="routine-add-action"
            >
              <Glyph name="newTask" size={13} color={signal.sage} />
              <Label color={signal.sage}>Add action</Label>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setDraft(null)}
              style={styles.smallButton}
              testID="routine-cancel"
            >
              <Label color={ink.muted}>Cancel</Label>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canManage || saveBlocked }}
              disabled={!canManage || saveBlocked}
              onPress={save}
              style={styles.smallButton}
              testID="routine-save"
            >
              <Glyph name="allow" size={13} color={!canManage || saveBlocked ? ink.faint : signal.sage} />
              <Label color={!canManage || saveBlocked ? ink.faint : signal.sage}>Save</Label>
            </Pressable>
          </View>
        </ScrollView>
      )}

      <Pressable accessibilityRole="button" onPress={onBack} style={styles.back} testID="routines-back">
        <Glyph name="back" size={13} color={ink.plain} />
        <Kicker color={ink.plain}>Back</Kicker>
      </Pressable>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ground.base, gap: space.step },
  header: { gap: space.hair, paddingHorizontal: space.wide, paddingTop: space.step },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { gap: space.step, paddingHorizontal: space.wide, paddingBottom: space.wide },
  notice: {
    gap: space.hair,
    marginHorizontal: space.wide,
    padding: space.step,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    backgroundColor: ground.raised,
  },
  card: {
    gap: space.step,
    padding: space.step,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    backgroundColor: ground.raised,
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: space.step },
  copy: { flex: 1, gap: space.hair },
  action: { flexDirection: "row", alignItems: "center", gap: space.step, paddingTop: space.hair },
  actionOrder: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ground.active,
  },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: space.hair },
  smallButton: {
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.hair,
    paddingHorizontal: space.step,
  },
  primaryButton: {
    minHeight: TOUCH_TARGET,
    marginHorizontal: space.wide,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.hair,
    backgroundColor: signal.sage,
  },
  secret: { gap: space.hair, padding: space.step, backgroundColor: ground.active },
  editor: { gap: space.step, paddingHorizontal: space.wide, paddingBottom: space.wide },
  editorAction: { gap: space.hair, padding: space.step, borderWidth: stroke.hair, borderColor: ground.line },
  optionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.hair },
  option: {
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.hair,
    paddingHorizontal: space.step,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    backgroundColor: ground.active,
  },
  optionSelected: { borderColor: signal.sage, backgroundColor: signalWash.sage },
  triggerSection: { gap: space.hair, padding: space.step, borderWidth: stroke.hair, borderColor: ground.line },
  triggerError: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.hair,
    padding: space.step,
    backgroundColor: signalWash.oxide,
  },
  input: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
    color: ink.bright,
    backgroundColor: ground.active,
    ...type.body,
  },
  promptInput: { minHeight: 88, paddingVertical: space.step, textAlignVertical: "top" },
  back: {
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.hair,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.edge,
  },
});
