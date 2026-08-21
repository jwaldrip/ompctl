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
    # Cellular through the hub is slower than a simulator on loopback: the
    # fleet screen mounts before the agents snapshot arrives, and treating
    # that empty flash as failure would fail a path that is about to work.
    # Waiting for a real row is the assertion the empty-state check wanted.
    And I can see "session-open-first"
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

  # The path's sentence, end to end. Every scenario above stays on the fleet,
  # so none of them can see the failure Jason actually reported: sessions
  # listed, and no way to drive one. This one opens the first agent session,
  # sends a real prompt through the hub, and waits for the agent to echo a
  # per-run nonce, which no earlier turn and no earlier run of this suite can
  # satisfy. The prompt forbids tools on purpose: the pairing behind the
  # Background carries prompt but not approve, so a tool-using turn would
  # stall on a clearance this device cannot grant and the echo would never
  # come. The report step prints the one bracketed marker the path check is
  # allowed to regex out of suite output; the canonical line remains the
  # check script's to print.
  @path
  Scenario: A session opens and answers a prompt sent from this device
    Then I report the sessions listed in "fleet-count"
    When I select "session-open-first"
    Then I can see "session"
    And I can see "composer-input"
    And I can see "transcript"
    When I fill in "composer-input" with "Do not use tools. Do not make a todo list. Reply with exactly this token and nothing else: <nonce>"
    And I dismiss the keyboard
    And I select "composer-send"
    Then the agent replies in "transcript" echoing "<nonce>"
    And I cannot see "toast"
    And I cannot see "toast-link"
    And I capture "12-round-trip"
