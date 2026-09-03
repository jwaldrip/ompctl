Feature: Pairing a device with a daemon

  The same scenarios run on web, iOS, and Android. Nothing below names a
  platform, a selector, or a screen size: the driver behind `E2E_CLIENT` decides
  what "select" and "fill in" mean, and every element is addressed by testID.

  Scenario: The first screen asks to be paired
    Then I can see "pair"
    And I can see "pair-form"
    And I can see "pair-endpoint"
    And I can see "pair-token"
    And I can see "pair-submit"
    And I capture "01-pair-empty"

  Scenario: An endpoint that is not a daemon is named as such
    When I fill in "pair-endpoint" with "https://example.com/not-a-daemon"
    And I dismiss the keyboard
    Then I can read "Not a hub address" in "pair-endpoint-kind"
    And I capture "02-pair-rejects-bad-endpoint"

  Scenario: A socket endpoint is recognised before any token is given
    When I fill in "pair-endpoint" with "<endpoint>"
    And I dismiss the keyboard
    Then "pair-endpoint-kind" contains "socket"
    And I capture "03-pair-endpoint-recognised"

  # Reaching the sessions screen is not evidence of a pairing. The app navigates
  # there optimistically, so a refused token lands on exactly this screen and
  # only then reports a websocket error. Asserting the empty state is ABSENT is
  # what separates the two: the session list can only be populated by a daemon
  # that accepted the credential. An earlier version of this scenario stopped at
  # "I can see fleet" and passed with a deliberately invalid token.
  Scenario: A paired device lands on its sessions and they load
    When I fill in "pair-endpoint" with "<endpoint>"
    And I dismiss the keyboard
    And I fill in "pair-token" with "<token>"
    And I dismiss the keyboard
    And I select "pair-submit"
    Then I can see "fleet"
    And I can see "fleet-title"
    And I can see "fleet-list"
    And I cannot see "fleet-empty"
    And I capture "04-fleet-paired"
    And I cannot see "pair-form"
