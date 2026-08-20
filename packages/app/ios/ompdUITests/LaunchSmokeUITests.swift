//
//  LaunchSmokeUITests.swift
//  ompdUITests
//
//  Simulator-safe smoke: the app launches and either the pairing screen or
//  the console is visible. No live daemon credentials required. This is the
//  CI gate for "the binary boots"; PairingUITests remains the device proof.
//

import XCTest

final class LaunchSmokeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAppLaunchesToPairingOrConsole() throws {
        let app = XCUIApplication()
        app.launch()

        let pairEndpoint = app.textFields["pair-endpoint"]
        let console = app.otherElements["console"]
        // 180s/30s, not 60s/15s. The 60s budget was measured and it is not a
        // margin, it is a coin flip: across unrelated branches this element
        // appeared at 23.1s, 41.1s, 54.1s, 54.1s, and twice at the full
        // ceiling, once on a branch that could not have caused it. A shared CI
        // runner on an older Xcode pays for an iPad simulator's first boot,
        // bundle fetch, and Hermes bytecode compilation, and that cost is not
        // stable run to run.
        //
        // A generous margin is cheap: a passing run returns as soon as the
        // element exists, so this costs nothing when the app is healthy. A
        // gate that intermittently fails a correct build is expensive, because
        // it teaches everyone to re-run red instead of reading it.
        let pairAppeared = pairEndpoint.waitForExistence(timeout: 180)
        let consoleAppeared = console.waitForExistence(timeout: 30)
        XCTAssertTrue(
            pairAppeared || consoleAppeared,
            "expected pairing screen (pair-endpoint) or console after launch"
        )

        if pairAppeared {
            // Fresh install / no saved pairing: endpoint must not ship with a
            // loopback default that can never work from a real device.
            let value = (pairEndpoint.value as? String) ?? ""
            let placeholderish = value == "Endpoint" || value.isEmpty
            XCTAssertTrue(
                placeholderish || !value.contains("127.0.0.1") && !value.contains("localhost"),
                "endpoint field must not default to loopback, was '\(value)'"
            )
            XCTAssertTrue(app.buttons["pair-submit"].exists, "pair-submit missing on pairing screen")
        }
    }
}
