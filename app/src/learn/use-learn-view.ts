import { createSessionValue } from "../shared/session-value";
import { parseLearnView } from "./views";

const learnView = createSessionValue("loki.learnView", parseLearnView);
export const useLearnView = learnView.use;
