import { createRoot } from "react-dom/client";
import "../styles.css";
import { Workbench } from "./workbench";

// Mounts the workbench in the page's root, as boot.tsx mounts the app; main.tsx imports this only in development.
const root = document.getElementById("root");
if (root) createRoot(root).render(<Workbench />);
