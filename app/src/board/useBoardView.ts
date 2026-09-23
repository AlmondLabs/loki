import { createSessionValue } from "../shared/sessionValue";
import { parseBoardView } from "./model";

/** The board's current view, shared by its list column and the pane, remembered for the window. */
const boardView = createSessionValue("loki.boardView", parseBoardView);
export const useBoardView = boardView.use;
