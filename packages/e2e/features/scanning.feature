Feature: Reaching the scanner and coming back

  Pairing by hand is one of two routes; the other is a QR code. What the scanner
  can actually do differs by platform - a browser has no camera, and a phone has
  one it must ask permission for - so these scenarios assert the navigation and
  the screen's own identity rather than the camera state. That keeps one feature
  file honest instead of forking it into a web dialect and a native dialect.

  Scenario: The scanner is reachable from the pair screen
    Then I can see "pair-form"
    When I select "pair-scan-entry"
    Then I can see "scan"
    And I capture "05-scan"

  Scenario: Leaving the scanner returns to manual entry
    When I select "pair-scan-entry"
    And I can see "scan"
    And I select "scan-cancel"
    Then I can see "pair-form"
    And I can see "pair-endpoint"
    And I cannot see "scan"
    And I capture "06-scan-cancelled"
