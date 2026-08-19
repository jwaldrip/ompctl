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

## Queue

Everything Jason has asked for, in exactly one state. Parked is not dropped.

**in-path**
- The Pixel path above
- Opening a dormant session lands on a blank "That session closed." screen. Observed by screenshot on the Pixel, tapping a dormant session with 119 messages. Most of the 541 sessions are dormant, so this blocks "opens one".
- Only the last reply is visible on a live session being watched
- A persistent websocket error sits at the bottom of the screen while messages still arrive
- No way back to the session list from a session view, which makes the closed screen a dead end
- Right align the folder and archive controls in the Sessions header to the trailing content edge

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
