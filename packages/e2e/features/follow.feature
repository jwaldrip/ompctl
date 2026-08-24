Feature: A transcript follows its newest entry until the operator leaves it

  Opening a session belongs at the conversation's newest entry, and the view
  keeps following while the operator sits there. A Load earlier prepend is the
  opposite ask: the operator scrolled into history on purpose, and a jump to
  the bottom is the surface stealing the page back. Both halves are asserted
  as rows on screen rather than scroll offsets, because no driver can read an
  offset. Mounted is not enough either: a virtualized list keeps whole
  viewports of rows mounted around the visible one, so a marker row being
  VISIBLE is the position.

  The session under test is seeded before the run with thirty turns of
  realistic one and two line rows: more than one screen, and twice what one
  history page serves, so the newest marker and the oldest marker land on
  different pages. `<session-id>` and `<run-nonce>` come from that seeding
  step's environment (OMPD_E2E_SESSION_ID, OMPD_E2E_NONCE); a committed
  constant would assert against a previous run's transcript.

  Background:
    When I fill in "pair-endpoint" with "<endpoint>"
    And I dismiss the keyboard
    And I fill in "pair-token" with "<token>"
    And I dismiss the keyboard
    And I select "pair-submit"
    Then I can see "fleet"
    And I can see "fleet-list"
    And I cannot see "fleet-empty"

  @follow
  Scenario: Opening pins to the newest entry, and Load earlier does not steal the view back
    # Flat list, most recently active first: the seeded session's file was
    # written moments ago, so its row lands inside the list's first window
    # instead of inside a directory group the virtualizer has not reached.
    When I select "grouped-toggle"
    And I select "sort-chip-lastActive"
    Then I can see "sort-direction-lastActive"
    And I can see "session-open-<session-id>"
    When I select "session-open-<session-id>"
    Then I can see "session"
    And I can see "transcript"
    # Half one: with no reading position to protect, the first paint pins to
    # the newest entry. The marker is the last row of the newest page, so it
    # is on screen only if the list actually followed all the way there.
    And "transcript" shows a row echoing "follow-newest-<run-nonce>"
    And I capture "16-follow-pinned-to-newest"
    # Reaching Load earlier means scrolling to the head of the list, which is
    # what makes the operator's position not-the-bottom before the older page
    # arrives.
    When I scroll "transcript" to its top
    Then I can see "history-load-earlier"
    When I select "history-load-earlier"
    # Half two: the older page prepends and the view stays in the history it
    # asked for. The oldest marker arriving on screen proves the prepend
    # landed; the newest marker staying off screen proves nothing jumped.
    Then "transcript" shows a row echoing "follow-oldest-<run-nonce>"
    And "transcript" shows no row echoing "follow-newest-<run-nonce>"
    And I capture "17-follow-held-in-history"
