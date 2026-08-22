# PATH

The one path. Nothing else ships until `bun run check:path` exits 0 and prints the strings below.

## The sentence

**A real phone that is not on the home network lists this laptop's live omp sessions, opens one, sends it a message, and receives the agent's reply.**

That is the whole product. Every other surface is breadth.

## The one device

**Pixel 7** (`panther`), adb serial `34241FDH2004KR`, attached over USB for control only.

Chosen because it is the only device that is simultaneously real hardware, unlocked, driveable without a human, and genuinely reachable off the home LAN through its own T-Mobile eSIM (`fast.t-mobile.com`, NR). No emulator and no simulator satisfies this path, because a simulator shares the host's network and therefore cannot prove the off-LAN claim at all.

Not yet in this path, and why:

- **BushidoPhone** (iPhone 17 Pro, `0280AC9F-551E-55DA-A969-62D4242A003C`). Blocked on a manual step: `devicectl` fails with `kAMDMobileImageMounterDeviceLocked: The device is locked.` It joins the path the moment the phone is unlocked and trusted while attached. Nothing else about it is unknown.
- **Jason's iPad** (`A11ECFB1-0403-5BA3-AC1E-EC288381DDDC`) and **Test iPhone**. Second and third surfaces. They are breadth until the Pixel path is green.

## How it launches

The build already installed on the device, launched the way a person launches it: by its icon, or by the universal link `https://app.ompctl.ai/...`. Never a Metro dev server. The check reads the version and build off the installed package and prints them, so a stale install fails loudly instead of passing quietly. That version assertion is the part that would have caught the Aug 16 and Aug 17 reports.

One correction to an earlier draft of this file, recorded rather than quietly dropped. That draft also banned "a fresh flash performed for the test" outright. That is not achievable for the automated round trip: Detox drives Android through Espresso, which requires an instrumentation package (`ai.ompctl.app.test`) alongside the app, and no release install carries one. Probed on the bench device: `pm list instrumentation` returns nothing for `ai.ompctl`, so Detox cannot attach to the installed build at all.

So the anti-stale intent is preserved by a parity assertion instead of a ban. The instrumented build used for the round trip must be built from the same commit, and the check asserts its version and build match the release install it is replacing. A run that flashes a newer build than the one on the device fails, which is the defect the ban was aimed at. A run that flashes the same build to gain instrumentation is not that defect.

### One manual precondition on iOS devices

The token field is masked, and iOS AutoFill offers to save a masked field as a password. That system sheet sits above the app, outside the element tree, so no automation can dismiss it: Detox stalls on a screen it cannot see, and a person mid-pairing gets interrupted.

There is no app-side opt-out. `autoComplete`, `textContentType` including `oneTimeCode`, and `passwordRules` were each measured against this flow and the sheet still appeared, so weakening the field is not the answer and the field stays masked. The switch that governs it belongs to the device: **Settings > General > AutoFill & Passwords > AutoFill Passwords and Passkeys, off.**

On a simulator the suite does this itself, writing `AutoFillPasswords` in the `com.apple.WebUI` domain, which is the same key that switch writes. That domain was read off a preference diff taken either side of toggling the real switch, so it is observed rather than guessed. Detox cannot drive physical iOS at all, so on a real iPhone or iPad the switch is a one time manual step per device. It belongs to the device rather than the app, so reinstalling the app does not clear it.

## Transport

**Hub relayed, over cellular, with the device's Wi-Fi off for the duration of the run.**

`wss://hub.ompctl.ai` is the only route. The daemon is `dmn_9cdff42ffce29714f43e9780087a09e308433180c63999e95cb63dc4ae6c441b`, dialing out from this laptop. LAN is not part of this path: the device is expected to leave the network the daemon sits on, so a run that succeeds over Wi-Fi has proven nothing.

## The command

```sh
bun run check:path
```

## Strings it must print

The run fails unless every one of these appears:

- `device 34241FDH2004KR Pixel_7` — the real hardware, by serial
- `installed ai.ompctl.app <versionName>/<versionCode>` — read off the device, not from a build
- `idiom phone` — the device class, so tablet chrome on a phone or phone chrome on a tablet is a failure
- `transport CELLULAR` — Wi-Fi confirmed down and cellular confirmed up
- `daemon dmn_9cdff…c441b registered inst_<id>` — the live daemon, through the hub
- `tunnel stable: 0 closures in 60s` — a registration line alone is not stability. The daemon logged `tunnel registered` several hundred times while this path was broken, because a second daemon leg sharing one identity kept evicting it with `4409 replaced by a newer connection`. Any churn in the window fails the run.
- `sessions listed: <n>` with `n >= 1` — the device sees this laptop's real sessions
- `round trip ok` — a message sent from the device reached the agent and the reply came back
- `PATH GREEN`

## Proving the check can fail

The check is not trusted until it has been observed failing. Each of these must produce a red run, and the check is wrong if any of them passes:

1. Stop the daemon: `launchctl bootout gui/$(id -u)/ai.ompctl`
2. Start a second daemon by hand alongside the launchd one, reproducing the `4409` eviction loop
3. Point the device at a wrong hub host
4. Leave the device on Wi-Fi
5. Uninstall `ai.ompctl.app` from the Pixel

## Blocked, and exactly on what

`bun run check:path --dry-run` is green on this machine: one daemon leg, 0 closures in a 60 second stability window, the Pixel read at `0.1.0/1`, idiom phone, and the daemon registered with hub instance `inst_804cbb4fefae6e74`. Phases 1, 2 and 4 hold.

The full run cannot go green here yet, for one named reason. Detox drives Android through Espresso and needs an instrumentation package, and building it needs the Android SDK. This machine has no Android SDK: there is no `ANDROID_HOME`, no `~/Library/Android/sdk`, and `./gradlew` stops at "SDK location not found". CI has it, via `android-actions/setup-android`, which is why the `0.1.0/1` build reached the device at all.

Two ways to unblock, and the choice is Jason's because one of them changes his machine:

1. Install the Android command line tools locally, accept the SDK licenses, and build the debug plus androidTest APKs from this commit. That makes the whole gate runnable on the bench, which is what he asked for when he said to test on real devices locally rather than simulators.
2. Take the debug and androidTest APKs from a CI run of this commit and install them on the Pixel over adb. No machine change, but the gate then depends on CI having built the artifact.

Until one of those happens, the honest status of this path is red, and the wire is not closed.

### Proven on 2026-08-19: the transport half

With the Pixel's Wi-Fi off, `wifi_on=0`, no `wlan0` IPv4 address at all, and the default network reporting `Transports: CELLULAR` on 5G, the app listed **545 sessions** from this laptop's daemon. The count had been 541 an hour earlier, so it was live data rather than a cache, and the top row was a `LIVE (TUI)` session last active 9 seconds prior. The new-session screen also rendered the daemon's own root, `/Users/jwaldrip`.

There is no route from that device to this laptop except `hub.ompctl.ai`, so the relay leg of the sentence is no longer an assumption.

### Proven on 2026-08-19: the whole sentence

Same device, same conditions, Wi-Fi still off and 5G in the status bar. The phone listed 546 sessions, opened a live TUI session in one of the operator's private repositories, and a prompt typed on the phone reached that terminal and came back as a reply.

So: a real phone, off the home network, listed this laptop's live sessions, opened one, sent it a message, and received the agent's reply. That is the sentence at the top of this file.

Two things this run also settled, and neither is cosmetic:

- The persistent `websocket error` toast was on screen the entire time, while 546 sessions loaded and a round trip completed. In the final frame it is physically covering the reply it was reporting a failure to receive. That is the notice outliving its condition, exactly as diagnosed, and the fix for it is in this branch.
- Tapping a row by screen coordinate is unreliable here. The list is live and status-sorted, so it re-sorted between a screenshot and a tap and opened a different project's session. The `session-open-first` marker exists for this reason, and any check that taps by coordinate instead of by testID is measuring luck.

### Proven on 2026-08-21: the sentence again, after the daemon stopped wedging

The session list was not slow, it was wedging the daemon. Three independent causes, each measured rather than guessed: synchronous `open`/`readdir`/`stat` on the event-loop thread (a process sample caught the main thread parked in `openat$NOCANCEL` while local `/v1/health` timed out); the cwd decoder walking the real filesystem recursively to reverse a lossy directory name; and SQLite returning `mtime_ms` with sub-microsecond drift, which turned 163 of 611 cache rows into false misses on every request. A fourth was self-inflicted: the streamed counter dropped the in-count yielding, so a 23MB transcript still stalled the loop for about 45ms. The mutation test caught that one, not review.

Live daemon after the fix: 611 sessions returned while 60 concurrent health probes all completed, worst 3.8ms. Before it, the same request hung indefinitely.

On the Pixel with Wi-Fi off, `wifi_on=0`, no `wlan0` address, over 5G:

- `@dormant`, 17 of 17 steps, exit 0, three consecutive runs.
- `@path`, 20 of 20 steps, exit 0, 611 sessions listed, the agent's reply matching the run's nonce exactly.

### Open defects seen by eye on the iPad, 2026-08-21

Captured frames, not code reading. These are visual truths with no home in a test yet:

- A session with 1,103 messages, 429k context and $264.16 spend rendered an entirely black transcript for a full 90 second wait, then rendered normally about two minutes later. There is no spinner, skeleton, or loading text, so a slow first history page is indistinguishable from a broken screen. This is the same shape as the complaint that started this work.
- **Fixed 2026-08-21.** A session row's readings ran underneath its own action buttons. The size reading read `10.` and then, in the gap between the two buttons, a stray `e`: the tail of the word `size`. The text was never truncated, it was overdrawn, which the visible sliver proves. The row's title line respected a content box that reserves the trailing action column and the readings line did not. The actions were already correct siblings; the body simply had no `minWidth: 0`, so the readings set a floor it could not shrink under, and React Native's default `overflow: visible` let the excess paint beneath the later-drawn buttons.
- Titles truncate near 14 characters on a 1640pt display, and group paths truncate at both ends, losing the org and the repo at once.
- **Withdrawn.** I recorded the LINKED / context / spend strip as overlaying the transcript. It does not: `StatusReadout` is a stacked sibling below the list, and what I saw was ordinary scroll clipping at the list's viewport edge. The claim was an overreach from a static frame.
- Unknown metrics render as a bare `--`, which reads as failure rather than "not known yet".
- A grey circle overlaps the system status bar in one frame; a light arc is clipped into the bottom-right corner of the pair and connections screens. Both are unexplained chrome.
- The primary button has two identities: an outlined ghost on the pair screen that looks exactly like the text inputs above it, and a solid green fill on connections.
- Gutters disagree between screens, about 120px on pair against about 20px edge-to-edge on connections, with `Active` flush to the boundary.

### Blocked on 2026-08-21: subagents never reach the daemon

A real omp host never sends `notifications/agent_registry`. Instrumentation placed above every early return in the handler logged zero calls while a real subagent ran to completion and returned its token in 4.7 seconds, and subagents write no separate session file. The Agent Hub's tree, its tests, and the daemon's handler are correct code fed by a source that never speaks, so "list every dispatched subagent" cannot hold against a real omp host. The daemon's subagent support is only ever exercised against a fake host that does emit the notification.

### Landed on 2026-08-22: sessions appear by themselves, narration and the mic are real

All four verified on the running daemon and by eye on the iPad simulator, not from a report.

- **A new local session pops.** The daemon watches the sessions root, coalesces the constant appends an agent makes while it works, joins the index's in-flight build rather than queueing another, and pushes only to sockets that already asked and hold read scope. Proven live: a client asked once, `ompd new` created a session, and an unsolicited frame arrived carrying it, 616 to 617, with no second request. The app's own fleet then read `617 SESSIONS`.
- **Narration speaks.** `OmpctlNarration` now exists natively: `AVSpeechSynthesizer` on iOS with the audio session category chosen so the ring/silent switch cannot mute it, `TextToSpeech` on Android with the asynchronous engine init handled so a speak before init never resolves while saying nothing. The session screen used to read "this build has no OmpctlNarration text-to-speech module"; it now reads "Narration off, read new agent prose aloud as it arrives".
- **The microphone is wired.** `OmpctlVoice` captures 16 kHz mono PCM16 and plays the daemon's `speech` frames back, against the voice bridge that already existed. The composer reads "Tap to speak; the agent answers out loud" where it used to name the missing module. Audio was never heard on hardware, so the wire is proven and the acoustics are not.
- **Live speech is a decision, not a build.** OMP `/live` is a Codex realtime WebRTC call owned by the TUI process: SDP POST to the Codex endpoint, a sideband websocket to OpenAI, `gpt-live-1-codex`, and the operator's own Codex credential on the machine that opens the call. Both legs are outbound calls that machine makes to OpenAI, not daemon routes a client could ask for, so the hub is not the obstacle and no tunnel through it would help. What the hub tunnels today is one request shape, a webhook fire, and generalising that is separately unwanted because a proxied daemon route would carry the device bearer token through the hub. The honest first slice is live duplex over the voice bridge already present, with turn taking rather than barge-in, and it needs no new dependency. True live voice needs `react-native-webrtc`, a WebRTC peer inside ompd, and eventually a TURN service. That is named rather than implied.

Two defects were found by looking at the frames rather than the code:

- Detox had been launching a stale simulator binary from the previous day, which is why both native modules still reported missing after they were built. The banners only changed once the build went to the path Detox actually launches. A screenshot of an app nobody rebuilt is not evidence about the code.
- Repeated rich blocks collided on their keys. React reported `Encountered two children with the same key, list:1:true` on the device. The renderer keyed blocks by content, so two rules both keyed to `rule` and two identical paragraphs collided the same way. Keys are position-prefixed now, and `packages/app/test/rich-text.test.tsx` reproduces the exact device complaint when the fix is reverted.

### Landed on 2026-08-22: routines can be scheduled, and sessions can be deleted for good

- **Routines were never missing, the phone was.** The daemon implements cron, interval, manual and webhook triggers and the scheduler is armed at boot. Proven rather than read: an interval routine produced eight runs, succeeding every 30 seconds, and stopped the moment it was disabled. What the app could create was hardcoded to webhook, so a scheduled routine was unreachable from the phone. The editor now offers Schedule, Webhook and Manual, can change an existing routine's kind, shows the next fire time, and blocks a save on an unparsable cron or a blank `cwd` with the reason stated rather than the control hidden. Cron evaluation moved into `@ompd/core` so exactly one implementation exists.
- **Sessions can be deleted, not just archived.** Archiving deliberately never touches the file. `SessionIndex.delete(ids)` removes the transcript and its sibling artifact directory, then drops the archive mark and the cached scan count in one transaction, file first so a failed unlink leaves consistent state. Exposed as `POST /v1/sessions/delete` and a `session_delete` frame, gated on manage scope, one audit record per id. The app arms before it acts: the first press replaces the row with a band naming the session, and archive is not rendered while armed.
- **302 fixture sessions removed on this machine**, taking the fleet from 625 to 323. Every id was chosen from a reviewed manifest, no file from the manifest remains on disk, no artifact directory remains, and the daemon wrote 302 `session.delete` / ok audit records.

Two defects this work found, both in the instruments rather than the product:

- A liveness read off `SessionSummary.status` made an archived session deletable while a process still held it, because an archive mark deliberately outranks liveness there. The index now returns the set of sessions a process actually holds and delete refuses from it.
- A probe reported scheduled routines dead after waiting 170 seconds for a `routine_ran` event. The database showed four successful runs inside that exact window: the event never reaches a socket that has not asked for routines. The probe was broken, not the scheduler, and it spent eight agent runs before it was stopped.

## Queue

Everything Jason has asked for, in exactly one state. Parked is not dropped.

**in-path**
- The Pixel path above
- Opening a dormant session lands on a blank "That session closed." screen. Observed by screenshot on the Pixel, tapping a dormant session with 119 messages. Most of the 541 sessions are dormant, so this blocks "opens one".
- Only the last reply is visible on a live session being watched
- A persistent websocket error sits at the bottom of the screen while messages still arrive
- No way back to the session list from a session view, which makes the closed screen a dead end
- Right align the folder and archive controls in the Sessions header to the trailing content edge
- A large session can show a black transcript with no loading state while its first history page is fetched, for at least 90 seconds. Seen by eye on the iPad, 2026-08-21
- Titles truncate near 14 characters and group paths truncate at both ends, on a display with room for both. Seen by eye on the iPad, 2026-08-21
- The notice used to float over the console and once covered the reply it was reporting on. It is a band in the column now, and `packages/app/test/no-hidden-content.test.ts` gates the class: a row clips its own content, a flex item holding text can shrink, readings wrap, and a notice never positions absolutely. Done 2026-08-21
- Two primary-button treatments and two content gutters across pair and connections; unknown metrics render as a bare `--`. Seen by eye on the iPad, 2026-08-21
- Subagents never reach the daemon, so the Agent Hub cannot list them against a real omp host. Diagnosed 2026-08-21, see above
- Live speech, slice A: live duplex over the voice bridge, turn taking, no WebRTC. Decided 2026-08-22, not started
- Live speech, slice B: true realtime voice, needs `react-native-webrtc`, a daemon WebRTC peer, and a TURN story. Open only if slice A's turn latency is not good enough to talk to
- Audio was never heard on hardware: narration and the mic are proven to the wire and to the UI, not to the speaker
- Deleting a session from the phone is untested on hardware: the row control and its confirmation are proven by unit tests and by 302 real deletions over HTTP, not by a thumb on a device
- Creating a scheduled routine from the phone is untested on hardware: the trigger picker lives behind the menu and no Detox path reaches it

**parked** (starts only after `PATH GREEN`)
- BushidoPhone, Jason's iPad, Test iPhone, Apple Watch
- macOS and Windows desktop, React Native Web
- CarPlay, watch mode, voice memo / live / narration modes, CallKit
- Notifications, collab, collab voice, plan review UI, agent hub UI, role and settings UI
- Cowork containers, session takeover from a TUI, QR device binding
- TestFlight and Play Console distribution, the marketing site
- Render markdown instead of raw text in the transcript
- Render diffs in a readable form
- View images and other attachments
- Trigger multiple actions per webhook event, for example text back and another app invoked from one event
- Let a terminal session and ompd share one session without either overwriting the other, by hosting OMP collab at the daemon instead of shipping `tui_activity` hints. Retires the `live-tui` carve-out in the fleet.

**done**
- Hub deployed and healthy at `hub.ompctl.ai`, DNS delegated to Google Cloud
- Domain, bundle ids, public repo
- Daemon dials the hub and registers

Those three `done` items are parts. None of them is this path.
