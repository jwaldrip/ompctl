Feature: Deleting a routine and copying its webhook URL on a device

  The routines screen is where an operator retires an automation they no
  longer want, so the delete path has to work from the device itself: the
  entry is the menu, not a deep link, and the confirm is the gate that makes
  an irreversible act deliberate. The same card is also where a webhook
  routine's instructions live, so the endpoint shown must be the one the
  daemon actually serves, and the once-only secret view must offer the URL
  ready to paste.

  This pairing carries manage scope, not the sessions feature's read and
  prompt, because delete is manage-gated: a read-only device would see the
  control disabled and nothing here could run.

  Background:
    When I fill in "pair-endpoint" with "<endpoint>"
    And I dismiss the keyboard
    And I fill in "pair-token" with "<token>"
    And I dismiss the keyboard
    And I select "pair-submit"
    Then I can see "fleet"
    When I select "open-menu"
    And I select "menu-routines"
    Then I can see "routines-screen"
    And I can see "routine-rtn_e2e_delete_me"

  # Rotation precedes deletion in this file on purpose: the daemon is shared
  # across scenarios and the delete scenario removes the routine the copy
  # scenario needs.
  Scenario: Rotating shows the secret once and copies the URL with its token
    Then I can see "routine-rtn_e2e_delete_me-endpoint"
    And "routine-rtn_e2e_delete_me-endpoint" contains "/v1/webhooks/rtn_e2e_delete_me"
    When I select "routine-rtn_e2e_delete_me-rotate-secret"
    Then I can see "routine-secret-value"
    And I can see "routine-rtn_e2e_delete_me-secret-url"
    And "routine-rtn_e2e_delete_me-secret-url" contains "?token="
    When I select "routine-secret-copy"
    Then "routine-secret-copy" contains "Copied"
    And I capture "14-routine-secret-copied"

  Scenario: Deleting a routine asks first, then takes it away
    When I select "routine-rtn_e2e_delete_me-delete"
    Then I can see "routine-rtn_e2e_delete_me-confirm-delete"
    And "routine-rtn_e2e_delete_me-confirm-delete" contains "e2e delete proof"
    When I select "routine-rtn_e2e_delete_me-confirm-yes"
    Then I can see "routines-empty"
    And I cannot see "routine-rtn_e2e_delete_me"
    And I capture "15-routine-deleted"
