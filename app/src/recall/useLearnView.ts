import { createSessionValue } from "../shared/session-value";
import { parseLearnView } from "./views";

/** Learn's current view, shared by its list column and the pane, remembered for the window. */
const learnView = createSessionValue("loki.learnView", parseLearnView);
export const useLearnView = learnView.use;
