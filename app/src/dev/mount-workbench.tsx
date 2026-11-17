import { createRoot } from "react-dom/client";
import "../styles.css";
import { Workbench } from "./workbench";

const root = document.getElementById("root");
if (root) createRoot(root).render(<Workbench />);
