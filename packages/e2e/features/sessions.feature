Feature: What a paired device can do with its sessions

  Everything here needs a real pairing, so the Background completes one. The
  daemon must hold at least one session for these to mean anything: an empty list
  would let the sort and connection assertions pass without touching real data,
  which is why the Background asserts the empty state is absent rather than
  merely that the screen appeared.

  Background:
    When I fill in "pair-endpoint" with "<endpoint>"
    And I dismiss the keyboard
    And I fill in "pair-token" with "<token>"
    And I dismiss the keyboard
    And I select "pair-submit"
    Then I can see "fleet"
    And I cannot see "fleet-empty"

  Scenario: The sessions list reports what the daemon actually holds
    Then I can see "fleet-list"
    And I can see "sort-bar"
    And "fleet-count" contains "session"
    And I capture "07-sessions-loaded"

  Scenario: Sorting is a real control, not decoration
    When I select "sort-chip-age"
    Then I can see "sort-direction-age"
    And I capture "08-sessions-sorted-by-age"

  Scenario: The connection this device is using can be inspected
    When I select "open-connection-switcher"
    Then I can see "connection-switcher"
    And I can see "add-connection"
    And I capture "09-connections"

  # The pairing used here grants read and prompt, not approve. Inviting another
  # device mints a credential, so the control is hidden rather than offered and
  # then refused. This asserts the scope gate holds in the UI, which is the half
  # a daemon-side permission check cannot cover.
  Scenario: A device without the approve scope is not offered the invite control
    When I select "open-connection-switcher"
    Then I can see "connection-switcher"
    And I cannot see "invite-device"
    And I capture "10-invite-hidden-without-scope"

  Scenario: Leaving the connection switcher returns to the sessions
    When I select "open-connection-switcher"
    And I can see "connection-switcher"
    And I select "close-connection-switcher"
    Then I can see "fleet"
    And I cannot see "connection-switcher"
    And I capture "11-back-to-sessions"
