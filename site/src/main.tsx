import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "../../app/src/theme";
import { Site } from "./site";
import "./site.css";

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <Site />
      </ThemeProvider>
    </StrictMode>,
  );
