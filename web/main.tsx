import { createRoot } from "react-dom/client";
import { Surface } from "./desk/Surface";
import { installVendor } from "./vendor";

// Expose host React/kit to runtime-authored widget modules before they load.
installVendor();

createRoot(document.getElementById("root")!).render(<Surface />);
