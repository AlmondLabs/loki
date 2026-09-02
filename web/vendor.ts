/**
 * Host-provided globals for runtime-authored widget modules. The main bundle
 * assigns window.__loci_vendor once; authored modules resolve react / the JSX
 * runtime / the kit from it via an import map (see index.html). This keeps
 * authored bundles tiny AND guarantees a single React instance (separate copies
 * break hooks).
 */
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as Kit from "./kit";

declare global {
  interface Window {
    __loci_vendor?: {
      react: typeof React;
      jsxRuntime: typeof JsxRuntime;
      kit: typeof Kit;
    };
  }
}

export function installVendor(): void {
  window.__loci_vendor = { react: React, jsxRuntime: JsxRuntime, kit: Kit };
}
