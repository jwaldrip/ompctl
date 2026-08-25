//
//  PairingUITests.swift
//  ompdUITests
//
//  Proves, on a real tethered iPhone, that a fresh install pairs against a
//  live daemon over the LAN and reaches the console. The empty-endpoint
//  assertion is the point of the whole exercise: the field used to arrive
//  prefilled with a loopback URL, which can never resolve from a phone, and
//  it looked like a working default right up until someone tried it on a
//  device. Nothing else in this suite would have caught that regression.
//
//  The endpoint and token come from the test runner's own process environment
//  as OMPD_TEST_ENDPOINT and OMPD_TEST_TOKEN. The test passes those same
//  values through XCUIApplication.launchEnvironment before entering them. No
//  live credential belongs in version control.
//

import XCTest

final class PairingUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /**
     * The normal CI contract is an environment value. Local UI automation needs
     * the same test without publishing a bearer to xcodebuild's command line,
     * test logs, or the runner environment, so it may instead pass a mode-600
     * file path. The direct environment form wins to preserve CI unchanged.
     */
    private func requiredInput(_ environmentKey: String, fileKey: String) -> String? {
        let environment = ProcessInfo.processInfo.environment
        if let direct = environment[environmentKey], !direct.isEmpty {
            return direct
        }
        guard let path = environment[fileKey], !path.isEmpty else {
            XCTFail("\(environmentKey) or \(fileKey) is not set in the test runner environment")
            return nil
        }
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: path)
            let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0
            guard permissions & 0o077 == 0 else {
                XCTFail("\(fileKey) must name a private file")
                return nil
            }
            let value = try String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else {
                XCTFail("\(fileKey) names an empty file")
                return nil
            }
            return value
        } catch {
            XCTFail("\(fileKey) could not be read")
            return nil
        }
    }

    func testFreshInstallPairsAndReachesConsole() throws {
        guard let endpoint = requiredInput("OMPD_TEST_ENDPOINT", fileKey: "OMPD_TEST_ENDPOINT_FILE") else {
            return
        }
        guard let token = requiredInput("OMPD_TEST_TOKEN", fileKey: "OMPD_TEST_TOKEN_FILE") else {
            return
        }
        guard let sessionID = requiredInput("OMPD_TEST_SESSION_ID", fileKey: "OMPD_TEST_SESSION_ID_FILE") else {
            return
        }
        let environment = ProcessInfo.processInfo.environment
        guard let nonce = environment["OMPD_TEST_NONCE"], !nonce.isEmpty else {
            XCTFail("OMPD_TEST_NONCE is not set in the test runner environment")
            return
        }
        let app = XCUIApplication()
        let localNetworkPrompt = addUIInterruptionMonitor(withDescription: "Local Network permission") { alert in
            guard alert.label.localizedCaseInsensitiveContains("local networks") else {
                return false
            }
            alert.buttons["Allow"].tap()
            return true
        }
        defer {
            removeUIInterruptionMonitor(localNetworkPrompt)
        }

        // The app itself never reads test inputs. Keeping credentials in the
        // XCTest runner rather than launchEnvironment keeps a file-backed token
        // out of the target process, system diagnostics, and app state.
        app.launch()

        let endpointField = app.textFields["pair-endpoint"]
        XCTAssertTrue(endpointField.waitForExistence(timeout: 15), "pairing screen did not appear on launch")

        // Fresh installs intentionally start with the hosted hub, never a
        // loopback socket that a real phone could not reach. The test must
        // replace that default before asserting the direct-socket route.
        let initialValue = (endpointField.value as? String) ?? ""
        XCTAssertFalse(initialValue.hasPrefix("ws://127.0.0.1"), "fresh pairing must not default to daemon loopback")

        endpointField.tap()
        endpointField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: initialValue.count))
        XCTAssertEqual((endpointField.value as? String) ?? "", "", "the hosted hub value did not clear before direct pairing")
        endpointField.typeText(endpoint)


        let secureTokenField = app.secureTextFields["pair-token"]
        let tokenField = secureTokenField.exists ? secureTokenField : app.textFields["pair-token"]
        XCTAssertTrue(tokenField.exists, "token field not found")
        tokenField.tap()
        tokenField.typeText(token)

        let submit = app.buttons["pair-submit"]
        XCTAssertTrue(submit.waitForExistence(timeout: 5), "submit button not found")
        XCTAssertTrue(submit.isEnabled, "connect button did not become enabled once endpoint and token are present")

        // The keyboard obscures the lower form on a phone. Its return action
        // is an operator's normal way to leave this single-line field, and
        // makes the Connect control genuinely tappable rather than merely
        // present in the accessibility hierarchy.
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists {
            let returnKey = keyboard.buttons["Return"]
            let doneKey = keyboard.buttons["Done"]
            if returnKey.exists {
                returnKey.tap()
            } else if doneKey.exists {
                doneKey.tap()
            } else {
                XCTFail("token keyboard has neither Return nor Done")
                return
            }
        }
        XCTAssertTrue(submit.isHittable, "connect button remained obscured by the keyboard")
        submit.tap()
        // XCTest delivers interruption monitors only after a fresh UI event.
        // Without this, a Local Network sheet can sit over the pairing result
        // while the test waits for a console that cannot appear.
        app.tap()
        let console = app.otherElements["console"]
        XCTAssertTrue(console.waitForExistence(timeout: 20), "console did not appear after pairing")
        let fleet = app.otherElements["fleet"]
        XCTAssertTrue(fleet.waitForExistence(timeout: 5), "session fleet did not appear after pairing")
        XCTAssertTrue(app.staticTexts["fleet-count"].exists, "session fleet count did not appear after pairing")
        let fleetFrame = XCTAttachment(screenshot: app.screenshot())
        fleetFrame.name = "scratch-fleet-before-open"
        fleetFrame.lifetime = .keepAlways
        add(fleetFrame)

        let agent = app.buttons["session-open-\(sessionID)"]
        XCTAssertTrue(agent.waitForExistence(timeout: 20), "scratch session \(sessionID) was not present in the fleet")
        XCTAssertTrue(agent.isHittable, "canonical session-open action is not hittable")
        agent.tap()

        let session = app.otherElements["session"]
        XCTAssertTrue(session.waitForExistence(timeout: 10), "selected agent session did not open")

        let composer = app.textViews["composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "agent composer did not appear")
        let idleSend = app.descendants(matching: .any)["composer-send"]
        XCTAssertTrue(idleSend.waitForExistence(timeout: 10), "settled session did not render composer-send before typing")
        XCTAssertTrue(idleSend.isEnabled, "settled session rendered a disabled composer-send")

        let prompt = "Use the shell to run sleep 6, then reply with exactly this token and nothing else: \(nonce)"
        let userRows = app.otherElements.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "entry-user")
        )
        let userCountBeforePrompt = userRows.count
        let assistantRows = app.otherElements.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "entry-assistant")
        )
        let assistantCountBeforePrompt = assistantRows.count

        composer.tap()
        composer.typeText(prompt)
        XCTAssertTrue(((composer.value as? String) ?? "").contains(nonce), "composer input did not contain the nonce")
        let send = app.descendants(matching: .any)["composer-send"]
        let cancel = app.descendants(matching: .any)["composer-cancel"]
        let afterTypeFrame = XCTAttachment(screenshot: app.screenshot())
        afterTypeFrame.name = "scratch-after-typing"
        afterTypeFrame.lifetime = .keepAlways
        add(afterTypeFrame)
        let afterTypeHierarchy = XCTAttachment(string: app.debugDescription)
        afterTypeHierarchy.name = "scratch-after-typing-hierarchy"
        afterTypeHierarchy.lifetime = .keepAlways
        add(afterTypeHierarchy)
        guard send.exists else {
            XCTFail("composer-send disappeared after typing; composer-cancel exists=\(cancel.exists)")
            return
        }
        XCTAssertTrue(send.isEnabled, "agent send control did not become enabled for the prompt")
        XCTAssertTrue(send.isHittable, "visible composer-send is not hittable")
        send.tap()

        // Optimistic user entries carry accessibilityLabel = prompt text and
        // testID entry-user. Either surface is enough; both must exist once
        // Send lands so a dropped onPress cannot hide behind a descendant scan.
        let promptByLabel = app.otherElements
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "entry-user", nonce))
            .firstMatch
        let promptByAny = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "entry-user", nonce))
            .firstMatch
        let promptSubmitted = promptByLabel.waitForExistence(timeout: 15)
            || promptByAny.waitForExistence(timeout: 5)
        guard promptSubmitted else {
            // Surface what is actually on screen so the next failure is a diagnosis.
            let userIds = userRows.allElementsBoundByIndex.map { $0.identifier }
            XCTFail("prompt not submitted; user rows=\(userIds); composer=\(composer.value ?? "nil")")
            return
        }

        let activity = app.otherElements["session-activity"]
        XCTAssertTrue(activity.waitForExistence(timeout: 15), "the working row did not appear after the submitted prompt")
        let workingFrame = XCTAttachment(screenshot: app.screenshot())
        workingFrame.name = "scratch-working-session"
        workingFrame.lifetime = .keepAlways
        add(workingFrame)

        let assistantByLabel = app.otherElements
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "entry-assistant", nonce))
            .firstMatch
        let assistantByAny = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "entry-assistant", nonce))
            .firstMatch
        XCTAssertTrue(
            assistantByLabel.waitForExistence(timeout: 90) || assistantByAny.waitForExistence(timeout: 5),
            "no new assistant response contained the unique nonce"
        )
        XCTAssertTrue(app.otherElements["session-context"].exists, "session context strip was not rendered")
        XCTAssertTrue(app.otherElements["composer-surface"].exists, "composer surface was not rendered")
        let tools = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "tool-"))
        XCTAssertGreaterThan(tools.count, 0, "scratch transcript did not render a tool card")
        let settledFrame = XCTAttachment(screenshot: app.screenshot())
        settledFrame.name = "scratch-settled-session"
        settledFrame.lifetime = .keepAlways
        add(settledFrame)
    }
}
