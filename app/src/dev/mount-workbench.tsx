import { createRoot } from "react-dom/client";
import "../styles.css";
import { LookProvider } from "../theme";
import { Workbench } from "./workbench";

// Mounts the workbench in the page's root, as boot.tsx mounts the app; main.tsx imports this only in development.
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <LookProvider look="glass">
      <Workbench />
    </LookProvider>,
  );
