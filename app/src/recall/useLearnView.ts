import { createSessionValue } from "../shared/session-value";
import { parseLearnView } from "./views";

/** Learn's current view, shared by its list column and the pane, remembered for the window. */
const learnView = createSessionValue("loki.learnView", parseLearnView);
/** Learn's current view and its setter, `[view, setView]`, the same in the list column and the pane. */
export const useLearnView = learnView.use;
