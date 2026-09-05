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
  type PromptImage,
  TERMINAL_AGENT_STATES,
  type WebViewActionResult,
} from "@ompd/core/contracts";
import type { ConnectionState } from "@ompd/core/ompd-client";
import { type JSX, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Divider } from "react-native-paper";
import { OmpComposer } from "../assistant/OmpComposer.tsx";
import { OmpThreadList, OmpThreadProvider } from "../assistant/OmpThread.tsx";
import { webViewCapability } from "../browser";
import { ActivityRow } from "../components/ActivityRow.tsx";
import { PlanCard } from "../components/PlanCard.tsx";
import { SessionContext, type SessionContextSource } from "../components/SessionContext.tsx";
import { SessionLoadFailed, SessionLoading, SessionLoadStalled } from "../components/SessionLoad.tsx";
import { StatusReadout } from "../components/StatusReadout.tsx";
import type { PendingWebViewAction, PromptScopeAccess, SessionLoad } from "../console/state.ts";
import type { WebViewTarget } from "../console/webview.ts";
import { routeWebViewAction } from "../console/webview.ts";
import { elapsed, modelLabel, shortenPath } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { SafeScreen, useOwnedBottomInset } from "../design/SafeScreen.tsx";
import { Data, Kicker, Label, Title } from "../design/text.tsx";
import { agentSignal, ground, ink, signal, space, stroke } from "../design/tokens.ts";
import { bottomInsetFor, useKeyboardInset } from "../design/useKeyboardInset.ts";
import { imageAttachmentPicker } from "../platform/attachments.ts";
import { agentActivity, conversationActivity } from "../session/activity.ts";
import type { SessionState } from "../session/model.ts";
import type { VoiceAvailability } from "../voice/memo.ts";
import { type NarrationSpeech, useNarration } from "../voice/narration.ts";

export interface SessionScreenProps {
  agent: Agent;
  session: SessionState;
  /**
   * The context panel's own data edge: the roster its subagents come from,
   * how this device reaches the session, and where a subagent tap lands.
   * Grouped for the reason `voice` is: a caller cannot supply two thirds of
   * it and get a panel that renders a plausible half-truth.
   */
  context: SessionContextSource;
  /**
   * Whether this pane has the session it opened, is still waiting for it, or
   * was refused it. Keyed on the agent by the console, so a frame for another
   * session can neither end this wait nor start one.
   */
  load: SessionLoad;
  /** Motion seam for the activity indicator. Unset in production. */
  reduceMotion?: boolean;
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
  onSubmit: (text: string, images?: PromptImage[]) => void;
  onCancel: () => void;
  /** Wake this exact durable session under a new live agent. */
  onResume?: () => void;
  /**
   * Present when this agent is a co-driven terminal joined through a
   * view-only link. The composer is replaced by the band, because every
   * steer from a view-only guest is refused and a control that can only
   * fail is a refusal with extra steps.
   */
  watchOnly?: string;
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
  const { agent, session, connection, load } = props;
  // Derived, so it cannot go stale: there is no timer and nothing remembered,
  // and a state that has gone idle reads idle on this very render. The gate is
  // what keeps chat free of resting chrome: a session that is merely ready
  // yields null here and adds no row, and the header's kicker below is what
  // carries "what this session IS".
  const activity = conversationActivity(agentActivity(agent, session, connection, load));
  const tone = signal[agentSignal(agent.state)];
  const terminal = TERMINAL_AGENT_STATES.includes(agent.state);
  const ownedBottom = useOwnedBottomInset();
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

  /**
   * The same sentence, minus the one form of it that is an instruction rather
   * than news.
   *
   * A refusal has to be on screen: an operator who cannot speak needs the
   * reason, and `Recording` is the only feedback that the microphone is open.
   * "Tap to speak; the agent answers out loud." is neither. It sat under the
   * field permanently, made a band of its own, and was the last thing keeping
   * the composer from reading as a single message surface. It is the
   * microphone's accessibility hint now, where it costs no pixels and is still
   * available to anyone who cannot see the glyph.
   */

  /**
   * Why a SEND will be refused, which is a different fact from why an approval
   * is.
   *
   * `props.refusal` is the daemon's approve-scope verdict -- "Sign this from a
   * device holding the approve scope" -- and it belongs to the clearance
   * surfaces, which is where it went before this screen had a composer that
   * could take one. Handing it to the composer told an operator who holds
   * prompt scope that their words would not go, under a send control that was
   * live and worked. So the composer is given the refusals that actually hold
   * its send, and they are exactly the two the store's `isSendDisabled`
   * derives from: a missing prompt scope, and a clearance still waiting.
   */
  const clearances = session.pendingApprovals.length + (session.planReview === null ? 0 : 1);
  const sendRefusal =
    props.voice.access === "missing"
      ? "This device does not hold the prompt scope. Pair it again with prompt access to steer this agent."
      : clearances > 0
        ? "Answer the clearance above before sending."
        : undefined;

  /**
   * What this session actually runs, for the control that opens its config.
   * Both halves come from state this screen already holds: the daemon's
   * session info first, the roster's record of the agent as the fallback. No
   * new fetch, and null when it was told neither.
   */
  const model = modelLabel(props.session.info.model ?? agent.model, props.session.info.thinkingLevel);

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
      {/*
        Named so a test can assert what this band does NOT contain: the
        activity indicator used to live here, and "it moved" is only provable
        by reading the header itself rather than by finding the row elsewhere.
      */}
      <View style={[styles.head, { borderBottomColor: tone }]} testID="session-head">
        <Pressable
          testID="session-back"
          accessibilityRole="button"
          accessibilityLabel="Back to sessions"
          onPress={props.onBack}
          style={({ pressed }) => [styles.headControl, pressed && { backgroundColor: ground.active }]}
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
            style={({ pressed }) => [styles.headControl, pressed && { backgroundColor: ground.active }]}
          >
            <Glyph name="browser" size={14} color={browserOpen ? tone : ink.muted} />
            <Label color={browserOpen ? ink.plain : ink.muted}>Browser</Label>
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
          style={({ pressed }) => [styles.headControl, pressed && { backgroundColor: ground.active }]}
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
        The seam between the chrome and the working area, drawn by Paper rather
        than by a border on the band above it. `Divider` reads `outlineVariant`
        off the theme, which IS `ground.line`, so this is the same hairline the
        band used to carry -- one element that means "these two things are
        divided" instead of a border rule repeated on every band in the app.
      */}
      <Divider bold />

      {/*
        The keyboard takes its space from the transcript, never from the
        composer. This was a KeyboardAvoidingView and it did nothing on an
        iPad: the send control's frame was identical with the keyboard up and
        down, so the text was visible and the button was not.
      */}
      {/*
        One provider for the whole body. The composer sits below the status
        readout on this screen, and `ComposerPrimitive` only works inside the
        provider, so wrapping here is what lets both surfaces stay exactly where
        they were instead of the readout moving under the composer.
      */}
      <OmpThreadProvider
        agent={agent}
        session={session}
        connection={connection}
        load={load}
        promptAccess={props.voice.access}
        canApprove={props.canApprove}
        refusal={props.refusal}
        onSubmit={props.onSubmit}
        onCancel={props.onCancel}
        onDecide={props.onDecide}
        onDecidePlan={props.onDecidePlan}
      >
        <View style={styles.body}>
          {load.phase === "loading" ? (
            <SessionLoading title={agent.name} />
          ) : load.phase === "stalled" ? (
            <SessionLoadStalled connection={connection} title={agent.name} />
          ) : load.phase === "failed" ? (
            <SessionLoadFailed
              message={load.error ?? "The daemon refused this session."}
              title={agent.name}
              onRetry={props.onLoadEarlier}
            />
          ) : (
            <>
              <SessionContext {...props.context} agent={agent} now={props.now} session={session} />
              <OmpThreadList
              entries={session.entries}
              canApprove={props.canApprove}
              refusal={props.refusal}
              onDecide={props.onDecide}
              spoken={props.spoken}
              header={
                <PlanCard
                  canApprove={props.canApprove}
                  onRespond={props.onDecidePlan}
                  plan={session.plan}
                  refusal={props.refusal}
                  review={session.planReview}
                />
              }
              footer={
                activity === null ? null : (
                  <ActivityRow activity={activity} reduceMotion={props.reduceMotion} testID="session-activity" />
                )
              }
              canLoadEarlier={props.historyBefore !== undefined && props.historyBefore !== null}
              loadingEarlier={props.historyLoading}
              onLoadEarlier={props.onLoadEarlier}
              historyCursor={typeof props.historyBefore === "number" ? props.historyBefore : null}
            />
          </>
        )}

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

          The pad is the inset this screen owns, zero when a shell above has
          already paid it, so a nested session lines up with the list beside
          it rather than floating an inset above. And the view that pays is
          the view that paints: a parent's padding is outside every child, so
          only a surface-coloured pad owner runs the composer's colour the
          last inset down to the screen edge instead of stopping short and
          showing the shell's base beneath the message box.

          Nothing else: this band pays no gutter and no top pad. Whichever of
          the four things below fills the slot brings its own `rhythm.gutter`,
          so they share one left edge without nesting two gutters, and the
          composer's own dock owns the vertical air above its surface. A top
          pad here would be added to that one, not replace it.
        */}
          <View
            style={[styles.composerSafe, { paddingBottom: bottomInsetFor(keyboardInset, ownedBottom) }]}
            testID="session-composer-safe"
          >
            {load.phase !== "ready" ? (
              // No actions on a session this pane does not have. A composer here
              // would take a prompt for a session that may turn out to be
              // refused, and a cancel control would offer to interrupt a turn
              // nobody has seen.
              <View style={styles.resume} testID="session-actions-withheld">
                <Label color={ink.muted}>
                  {load.phase === "loading"
                    ? "Opening this session. Its controls appear with its transcript."
                    : load.phase === "stalled"
                      ? "The link dropped before this session arrived. Its controls return with it."
                      : "This session did not open, so there is nothing to steer."}
                </Label>
              </View>
            ) : props.watchOnly !== undefined ? (
              // The band takes the composer's place rather than sitting above
              // it: every steer from a view-only guest is refused, and a
              // control that can only fail is a refusal with extra steps.
              <View style={styles.resume} testID="session-watch-only">
                <Label color={ink.muted}>{props.watchOnly}</Label>
              </View>
            ) : terminal ? (
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
                <OmpComposer
                  prefix="composer"
                  picker={imageAttachmentPicker}
                  placeholder={connection === "connected" ? "Say something to this agent" : "No link"}
                  sendLabel="Send"
                  voice={props.voice}
                  model={model}
                  onOpenConfig={props.onOpenConfig}
                  refusal={sendRefusal}
                />
              </View>
            )}
          </View>
        </View>
      </OmpThreadProvider>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  // Owns the space between the header and the bottom of the screen, so the
  // keyboard's inset lands here rather than on top of the composer.
  //
  // It is also where this screen's vertical rhythm is set, once, for every
  // instrument in it. `sectionGap` above, because the chrome bands and the
  // working area are genuinely different sections and nothing separated them
  // but a hairline. `rowGap` between, because the context strip, the plan
  // card, the transcript, the readout and the dock are consecutive rows of
  // the same kind: instruments. Before this they had no gap at all and each
  // one made up its own margin, which is the vertical half of what the
  // operator was reporting.
  body: { flex: 1, minHeight: 0, paddingTop: rhythm.sectionGap, gap: rhythm.rowGap },
  // The band that owns the screen's bottom edge, composer to home
  // indicator. It paints the composer's surface because it is the view that
  // pays the inset below the composer: a parent's padding is outside every
  // child, so a transparent pad owner is how the shell's base colour ends up
  // showing between the message box and the screen edge.
  //
  // No gutter and no top pad here, on purpose. See the comment at the call
  // site: the four things that can fill this slot each pay `gutter`, and the
  // composer's own dock owns the air above its surface.
  composerSafe: { backgroundColor: ground.surface },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: rhythm.gutter,
    paddingVertical: space.snug,
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.heavy,
  },
  // One block for every labelled control in the chrome: the back control, the
  // browser toggle and the narration switch. They were three blocks saying
  // almost the same thing -- 8 here, 8 there, a `minWidth` on one of them --
  // which is how a header ends up with controls of three different widths.
  //
  // Labelled on purpose, all of them. An icon alone under a thumb is how an
  // operator ends up trapped in a session with no idea the bay is one tap
  // away, so `minTarget` is a floor on the height and the word sets the width.
  headControl: {
    minHeight: rhythm.minTarget,
    paddingHorizontal: rhythm.controlPad,
    flexDirection: "row",
    alignItems: "center",
    gap: rhythm.glyphGap,
  },
  narration: {
    minHeight: rhythm.minTarget,
    paddingHorizontal: rhythm.gutter,
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    backgroundColor: ground.surface,
  },
  narrationReason: { flex: 1 },
  ident: { flex: 1, gap: rhythm.pairGap },
  meta: { flexDirection: "row", alignItems: "center", gap: space.tight },
  origin: { flexShrink: 1 },
  browser: {
    height: 320,
    borderTopWidth: stroke.heavy,
    borderTopColor: ground.edge,
    backgroundColor: ground.surface,
  },
  // The three bands that stand in for the composer. They pay the screen
  // gutter themselves rather than taking one from the band around them, so
  // whichever of the four fills the slot, its first character starts at the
  // same x as the header's back control and the readout's link chip.
  resume: {
    paddingHorizontal: rhythm.gutter,
    paddingVertical: rhythm.rowGap,
    gap: rhythm.rowGapTight,
    backgroundColor: ground.surface,
    borderTopWidth: stroke.heavy,
    borderTopColor: ground.edge,
  },
  resumeButton: {
    minHeight: rhythm.minTarget,
    alignSelf: "flex-start",
    paddingHorizontal: rhythm.controlPad,
    flexDirection: "row",
    alignItems: "center",
    gap: rhythm.glyphGap,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  driver: { flex: 1 },
});
