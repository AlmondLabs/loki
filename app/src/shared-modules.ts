import * as React from "react";
import * as ReactDOM from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import * as recharts from "recharts";
import * as kit from "./kit/index";

/**
 * The modules agent-written widgets import. In the Tauri shell widgets are
 * transpiled by the Rust core, which rewrites `import … from "react"` into
 * reads from this table, so a widget shares the app's React instead of
 * loading a second copy (which would break hooks).
 */
declare global {
  interface Window {
    __lokiShared?: Record<string, unknown>;
  }
}

window.__lokiShared = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react-dom": ReactDOM,
  recharts,
  "@loki/kit": kit,
};
