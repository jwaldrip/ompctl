import { type RemoteRoutine, type Run, SCOPE_MANAGE, SCOPE_PROMPT } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { createOmpdClient } from "../console/useConsole.ts";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Display, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";

type RoutineStatus =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; routines: RemoteRoutine[]; runs: Run[] };

function mintId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function newWebhookRoutine(): RemoteRoutine {
  const id = mintId("rtn");
  return {
    id,
    name: "Webhook routine",
    enabled: true,
    trigger: { kind: "webhook", secretRef: mintId("whsec") },
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

  const save = useCallback(() => {
    if (!canManage || draft === null || draft.actions.length === 0) return;
    setPending(`save:${draft.id}`);
    client.writeRoutine(draft);
    setDraft(null);
  }, [canManage, client, draft]);

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
            return (
              <View key={routine.id} style={styles.card} testID={`routine-${routine.id}`}>
                <View style={styles.cardHeader}>
                  <View style={styles.copy}>
                    <Title>{routine.name}</Title>
                    <Label color={ink.muted}>
                      {routine.trigger.kind === "webhook" ? "Webhook" : routine.trigger.kind} trigger
                    </Label>
                  </View>
                  <Label color={routine.enabled ? signal.sage : ink.faint}>{routine.enabled ? "On" : "Off"}</Label>
                </View>

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
                    onPress={() => setDraft({ ...routine, actions: routine.actions.map(action => ({ ...action })) })}
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
          onPress={() => setDraft(newWebhookRoutine())}
          style={styles.primaryButton}
          testID="routines-new"
        >
          <Glyph name="newTask" size={14} color={canManage ? ground.base : ink.faint} />
          <Kicker color={canManage ? ground.base : ink.faint}>New webhook routine</Kicker>
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
                onChangeText={value => updateAction(index, "cwd", value)}
                placeholder="Working directory"
                placeholderTextColor={ink.faint}
                style={styles.input}
                testID={`routine-action-${index}-cwd`}
                value={action.cwd}
              />
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
            <Pressable accessibilityRole="button" onPress={save} style={styles.smallButton} testID="routine-save">
              <Label color={signal.sage}>Save</Label>
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
