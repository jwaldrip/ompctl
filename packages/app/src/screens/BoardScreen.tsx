/**
 * Standalone BoardScreen for the session kanban board.
 *
 * Can be used as a standalone screen or embedded by FleetScreen.
 */

import type { JSX } from "react";
import { memo } from "react";
import { SessionBoard, type SessionBoardProps } from "../components/SessionBoard.tsx";

export type BoardScreenProps = SessionBoardProps;

export const BoardScreen = memo(function BoardScreen(props: BoardScreenProps): JSX.Element {
  return <SessionBoard {...props} />;
});
