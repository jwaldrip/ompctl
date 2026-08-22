/**
 * One agent's log, with its instruments under it.
 *
 * The header carries identity and state; the transcript carries the work; the
 * readout carries the two numbers that decide whether to keep going. Composer
 * last, because it is the only thing here a thumb reaches for.
 */

import {
  type Agent,
  type ApprovalChoice,
  type ApprovalScope,
  type PlanReviewChoice,
  TERMINAL_AGENT_STATES,
  type WebViewActionResult,
} from "@ompd/core/contracts";
import type { ConnectionState } from "@ompd/core/ompd-client";
import { type JSX, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { webViewCapability } from "../browser";
import { Composer } from "../components/Composer.tsx";
import { PlanCard } from "../components/PlanCard.tsx";
import { StatusReadout } from "../components/StatusReadout.tsx";
import { Transcript } from "../components/Transcript.tsx";
import type { PendingWebViewAction, PromptScopeAccess } from "../console/state.ts";
import type { WebViewTarget } from "../console/webview.ts";
import { routeWebViewAction } from "../console/webview.ts";
import { elapsed, shortenPath } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Data, Kicker, Label, Title } from "../design/text.tsx";
import { agentSignal, ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import { bottomInsetFor, useKeyboardInset } from "../design/useKeyboardInset.ts";
import type { SessionState } from "../session/model.ts";
import type { VoiceAvailability } from "../voice/memo.ts";
import { type NarrationSpeech, useNarration } from "../voice/narration.ts";

export interface SessionScreenProps {
  agent: Agent;
  session: SessionState;
  connection: ConnectionState;
  attempt: number;
  delayMs?: number;
  canApprove: boolean;
  refusal?: string;
  /** The daemon's prose for the last settled turn, if it sent one. */
  spoken: string | null;
  /** Device speech implementation. Omitted in production so the native module is discovered once. */
  narrationSpeech?: NarrationSpeech;
  /** Pending clearances across the fleet, so the readout is not agent-local. */
  fleetClearances: number;
  onBack: () => void;
  /** The composer's voice path: scope posture, capabilities, dictation, toggle. */
  voice: SessionVoice;
  /** Open this agent's config surface: the mode it runs and the model it names. */
  onOpenConfig?: () => void;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  /** Wake this exact durable session under a new live agent. */
  onResume?: () => void;
  historyBefore?: number | null;
  historyLoading?: boolean;
  onLoadEarlier?: () => void;
  onDecide: (requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
  onDecidePlan: (requestId: string, choice: PlanReviewChoice) => void;
  /** The action this selected screen must perform next, keyed by request id. */
  pendingWebViewAction?: PendingWebViewAction;
  /** Register this selected screen as the agent's live WebView target. */
  onMountWebView?: () => void;
  /** Withdraw the selected screen's WebView target. Always called on unmount. */
  onUnmountWebView?: () => void;
  /** Return the result for precisely the action request that produced it. */
  onWebViewResult?: (requestId: string, result: WebViewActionResult) => void;
  now?: number;
}

/**
 * Everything the composer's voice path needs, built by the console from its
 * own state and the device seam. One object rather than seven props, so a
 * caller cannot wire half the microphone.
 */
export interface SessionVoice {
  /** The console's three-way prompt scope posture; only `missing` refuses. */
  readonly access: PromptScopeAccess;
  /** Device capture capability, with its reason when absent. */
  readonly mic: VoiceAvailability;
  /** Device speech playback capability, with its reason when absent. */
  readonly speech: VoiceAvailability;
  /** The daemon's live decoding of this device's utterance, once it has one. */
  readonly dictation: { readonly text: string; readonly final: boolean } | null;
  /** True while this device's microphone is open for this agent. */
  readonly capturing: boolean;
  /** True while another session holds this device's single microphone. */
  readonly busyElsewhere: boolean;
  /** Toggle the microphone for this agent: one press opens or closes it. */
  readonly onToggle: () => void;
}

export function SessionScreen(props: SessionScreenProps): JSX.Element {
  const { agent, session, connection } = props;
  const tone = signal[agentSignal(agent.state)];
  const busy = agent.state === "busy";
  const terminal = TERMINAL_AGENT_STATES.includes(agent.state);
  const insets = useSafeAreaInsets();
  const narration = useNarration(session.entries, props.narrationSpeech);

  const [browserOpen, setBrowserOpen] = useState(false);
  // Shared with every other bottom-anchored control, so the mechanism is one
  // thing rather than a copy per screen.
  const keyboardInset = useKeyboardInset();
  const driver = useRef<WebViewTarget | null>(null);
  const executedRequestId = useRef<string | null>(null);

  /**
   * The callbacks as of the last render, read rather than depended on.
   *
   * A parent that rebuilds these per render is the ordinary case: `Console`
   * closes over `agent.id`, and the log re-renders on every update frame of a
   * live turn. Depending on their identity would make the effects below
   * unregister and re-register on each of those, which is not merely noisy: in
   * the window between the two frames the daemon has no target for this agent.
   */
  const handlers = useRef({
    onMountWebView: props.onMountWebView,
    onUnmountWebView: props.onUnmountWebView,
    onWebViewResult: props.onWebViewResult,
  });
  useEffect(() => {
    handlers.current = {
      onMountWebView: props.onMountWebView,
      onUnmountWebView: props.onUnmountWebView,
      onWebViewResult: props.onWebViewResult,
    };
  });
  /**
   * The microphone gate, cheapest refusal first: what this build can do,
   * what this pairing may do, whether the one microphone is busy elsewhere,
   * then the link. Every refusal is named in the row beside the button
   * rather than taking the control away, because a missing button is read as
   * a missing feature, and `unknown` scope stays pressable exactly as the
   * three-way rule requires: the daemon's refusal, not a local guess, is
   * what turns it off.
   */
  const voice = props.voice;
  const micGate = !voice.mic.available
    ? "unavailable"
    : voice.access === "missing"
      ? "scope"
      : voice.busyElsewhere
        ? "busy"
        : connection !== "connected"
          ? "offline"
          : "ready";
  const micDisabled = micGate !== "ready" && !voice.capturing;
  // The same ladder as the gate, restated so each branch reads its own
  // availability object and TypeScript can narrow it: a gate label cannot
  // carry the reason, the object can.
  const micStatus = !voice.mic.available
    ? voice.mic.reason
    : voice.access === "missing"
      ? "This device does not hold the prompt scope. Pair it again with prompt access to speak to this agent."
      : voice.busyElsewhere
        ? "The microphone is already open in another session."
        : connection !== "connected"
          ? "No link"
          : voice.capturing
            ? "Recording"
            : voice.speech.available
              ? "Tap to speak; the agent answers out loud."
              : voice.speech.reason;

  /**
   * Leaving this screen mid-recording is the one moment this cleanup may
   * run, so the latest toggle is held in a ref rather than depended on: a
   * re-render must not end a live utterance, and an unmount must not leave
   * a microphone streaming with no control on screen to stop it.
   */
  const micRef = useRef({ capturing: voice.capturing, toggle: voice.onToggle });
  micRef.current = { capturing: voice.capturing, toggle: voice.onToggle };
  useEffect(
    () => () => {
      if (micRef.current.capturing) micRef.current.toggle();
    },
    [],
  );

  /**
   * This is a capability registration, not a visibility preference. A
   * registered screen can receive an action while its sandbox pane is closed,
   * then open the pane and execute it. The web build has no embedded sandbox
   * and must never claim one.
   *
   * Keyed on `agent.id`, not referenced in the body: switching to another
   * agent must unmount this registration and mount a fresh one, or the new
   * agent silently inherits a target nobody offered it.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: agent.id intentionally forces re-registration on agent switch; see comment above.
  useEffect(() => {
    if (webViewCapability === null) return;
    handlers.current.onMountWebView?.();
    return () => {
      handlers.current.onUnmountWebView?.();
    };
  }, [agent.id]);

  const actionRequestId = props.pendingWebViewAction?.requestId;
  useEffect(() => {
    if (actionRequestId === undefined) return;
    setBrowserOpen(true);
  }, [actionRequestId]);

  /**
   * Browser creation follows the action one render later. Remembering the
   * request id makes every re-render, stale state update, and duplicate frame
   * harmless: the driver receives this request exactly once.
   */
  useEffect(() => {
    const pending = props.pendingWebViewAction;
    const target = driver.current;
    if (pending === undefined || !browserOpen || target === null) return;
    if (executedRequestId.current === pending.requestId) return;
    executedRequestId.current = pending.requestId;
    void routeWebViewAction(target, pending.action, result => {
      handlers.current.onWebViewResult?.(pending.requestId, result);
    });
  }, [browserOpen, props.pendingWebViewAction]);

  return (
    <SafeScreen edges={{ top: true, bottom: false, left: true, right: true }} testID="session">
      <View style={[styles.head, { borderBottomColor: tone }]}>
        <Pressable
          testID="session-back"
          accessibilityRole="button"
          accessibilityLabel="Back to sessions"
          onPress={props.onBack}
          style={({ pressed }) => [styles.back, pressed && { backgroundColor: ground.active }]}
        >
          <Glyph name="back" size={14} color={ink.plain} />
          <Label color={ink.plain} testID="session-back-label">
            Sessions
          </Label>
        </Pressable>

        <View style={styles.ident}>
          <Title heading numberOfLines={1} testID="session-name">
            {agent.name}
          </Title>
          <View style={styles.meta}>
            <Label color={ink.muted} numberOfLines={1} style={styles.origin}>
              {shortenPath(agent.cwd, 3)}
            </Label>
            <Data color={ink.faint}>{elapsed(agent.lastActiveAt, props.now)}</Data>
          </View>
        </View>

        <Kicker color={tone} testID="session-state">
          {agent.state}
        </Kicker>

        {webViewCapability === null ? null : (
          <Pressable
            testID="session-browser-toggle"
            accessibilityRole="button"
            accessibilityLabel={browserOpen ? "Close the agent's browser" : "Open the agent's browser"}
            accessibilityState={{ selected: browserOpen }}
            onPress={() => {
              setBrowserOpen(open => !open);
            }}
            style={({ pressed }) => [styles.headAction, pressed && { backgroundColor: ground.active }]}
          >
            <Glyph name="browser" size={14} color={browserOpen ? tone : ink.muted} />
            <Label color={browserOpen ? ink.plain : ink.muted}>Browser</Label>
          </Pressable>
        )}

        {props.onOpenConfig === undefined ? null : (
          <Pressable
            testID="session-open-config"
            accessibilityRole="button"
            accessibilityLabel="Open this session's mode and model"
            onPress={props.onOpenConfig}
            style={({ pressed }) => [styles.headAction, pressed && { backgroundColor: ground.active }]}
          >
            <Glyph name="config" size={14} color={ink.muted} />
            <Label color={ink.muted}>Config</Label>
          </Pressable>
        )}
      </View>

      <View
        testID="session-narration"
        style={[styles.narration, narration.enabled && { backgroundColor: ground.active }]}
      >
        <Pressable
          testID="session-narration-toggle"
          accessibilityRole="switch"
          accessibilityLabel={
            !narration.available
              ? "Narration unavailable"
              : narration.enabled
                ? "Turn narration off"
                : "Turn narration on"
          }
          accessibilityState={{ checked: narration.enabled, disabled: !narration.available }}
          disabled={!narration.available}
          onPress={narration.toggle}
          style={({ pressed }) => [styles.narrationToggle, pressed && { backgroundColor: ground.active }]}
        >
          <Glyph name="narration" size={14} color={narration.enabled ? signal.sage : ink.muted} />
          <Label color={narration.enabled ? ink.bright : ink.muted} testID="session-narration-status">
            {!narration.available ? "Narration unavailable" : narration.enabled ? "Narration on" : "Narration off"}
          </Label>
        </Pressable>
        <Label
          color={narration.reason === null ? ink.faint : signal.slate}
          style={styles.narrationReason}
          testID="session-narration-reason"
        >
          {narration.reason ??
            (narration.enabled
              ? "Reading new agent prose as it arrives."
              : "Read new agent prose aloud as it arrives.")}
        </Label>
      </View>

      {/*
        The keyboard takes its space from the transcript, never from the
        composer. This was a KeyboardAvoidingView and it did nothing on an
        iPad: the send control's frame was identical with the keyboard up and
        down, so the text was visible and the button was not.
      */}
      <View style={styles.body}>
        <PlanCard
          canApprove={props.canApprove}
          onRespond={props.onDecidePlan}
          plan={session.plan}
          refusal={props.refusal}
          review={session.planReview}
        />

        <Transcript
          entries={session.entries}
          canApprove={props.canApprove}
          refusal={props.refusal}
          onDecide={props.onDecide}
          spoken={props.spoken}
          canLoadEarlier={props.historyBefore !== undefined && props.historyBefore !== null}
          loadingEarlier={props.historyLoading}
          onLoadEarlier={props.onLoadEarlier}
        />

        {webViewCapability === null || !browserOpen ? null : (
          <View style={styles.browser} testID="session-browser">
            <webViewCapability.Driver ref={driver} style={styles.driver} />
          </View>
        )}

        <StatusReadout
          state={connection}
          attempt={props.attempt}
          delayMs={props.delayMs}
          usage={session.usage}
          clearances={props.fleetClearances}
        />

        {/*
          Below the composer sits either the keyboard or the home indicator,
          never both: while the keyboard is up it covers that inset entirely,
          so paying both would leave a gap the height of the indicator.
        */}
        <View style={{ paddingBottom: bottomInsetFor(keyboardInset, insets.bottom) }} testID="session-composer-safe">
          {terminal ? (
            <View style={styles.resume}>
              <Label color={ink.muted}>This agent stopped. Its complete transcript stays available.</Label>
              {props.onResume === undefined ? null : (
                <Pressable
                  testID="session-resume"
                  accessibilityRole="button"
                  accessibilityLabel={`Resume ${agent.name}`}
                  onPress={props.onResume}
                  style={({ pressed }) => [styles.resumeButton, pressed && { backgroundColor: ground.active }]}
                >
                  <Glyph name="resume" size={13} color={tone} />
                  <Label color={ink.plain}>Resume session</Label>
                </Pressable>
              )}
            </View>
          ) : (
            <View testID="session-voice">
              {/*
                A band in the column, never a layer over it: the microphone
                and its status occupy real space above the composer, so a
                long refusal or a long dictation pushes the composer down
                rather than painting across it.
              */}
              <View style={styles.micRow}>
                <Pressable
                  testID="composer-mic"
                  accessibilityRole="button"
                  accessibilityLabel={voice.capturing ? "Stop the microphone and send" : "Speak to this agent"}
                  accessibilityState={{ disabled: micDisabled, selected: voice.capturing }}
                  disabled={micDisabled}
                  onPress={voice.onToggle}
                  style={({ pressed }) => [
                    styles.mic,
                    voice.capturing && styles.micLive,
                    micDisabled && styles.micOff,
                    pressed && { backgroundColor: ground.active },
                  ]}
                >
                  <Glyph
                    name="mic"
                    size={14}
                    color={voice.capturing ? signal.amber : micDisabled ? ink.faint : ink.plain}
                  />
                </Pressable>
                <Label
                  color={micGate === "ready" && !voice.capturing ? ink.faint : ink.plain}
                  style={styles.micStatus}
                  testID="composer-mic-status"
                >
                  {micStatus}
                </Label>
              </View>
              {voice.dictation === null ? null : (
                <Label color={ink.bright} style={styles.dictation} testID="composer-dictation">
                  {voice.dictation.final ? voice.dictation.text : `${voice.dictation.text} ...`}
                </Label>
              )}
              <Composer
                enabled={connection === "connected"}
                busy={busy}
                onSubmit={props.onSubmit}
                onCancel={props.onCancel}
              />
            </View>
          )}
        </View>
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  // Owns the space between the header and the bottom of the screen, so the
  // keyboard's inset lands here rather than on top of the composer.
  body: { flex: 1 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.heavy,
  },
  // Labeled on purpose. An icon alone under a thumb is how an operator ends up
  // trapped in a session with no idea the bay is one tap away.
  back: {
    minHeight: TOUCH_TARGET,
    minWidth: TOUCH_TARGET,
    paddingHorizontal: space.snug,
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  headAction: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.snug,
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  narration: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  narrationToggle: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.snug,
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  narrationReason: { flex: 1 },
  ident: { flex: 1, gap: space.hair },
  meta: { flexDirection: "row", alignItems: "center", gap: space.snug },
  origin: { flexShrink: 1 },
  browser: {
    height: 320,
    borderTopWidth: stroke.heavy,
    borderTopColor: ground.edge,
    backgroundColor: ground.surface,
  },
  resume: {
    padding: space.step,
    gap: space.snug,
    backgroundColor: ground.surface,
    borderTopWidth: stroke.heavy,
    borderTopColor: ground.edge,
  },
  // The microphone band sits above the composer and owns its space in the
  // column: a refusal or a live dictation grows downward, never over the
  // composer below it.
  micRow: {
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.step,
    backgroundColor: ground.surface,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.edge,
  },
  mic: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: stroke.hair,
    borderColor: ground.line,
    backgroundColor: ground.base,
  },
  micLive: { borderColor: signal.amber },
  micOff: { borderColor: ground.edge },
  // Shrinkable on purpose: a flex item's minimum is its content by default,
  // and an unshrinkable status is what paints over siblings.
  micStatus: { flex: 1, minWidth: 0 },
  dictation: {
    paddingHorizontal: space.step,
    paddingBottom: space.snug,
    backgroundColor: ground.surface,
  },
  resumeButton: {
    minHeight: TOUCH_TARGET,
    alignSelf: "flex-start",
    paddingHorizontal: space.step,
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  driver: { flex: 1 },
});
