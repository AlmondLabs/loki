// Import-map target for "react" in authored modules. Re-exports the host's
// single React instance so hooks work across separately-bundled modules.
const react = window.__loci_vendor.react;
export default react;
export const {
  useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext,
  createElement, Fragment, Component, createContext, memo,
} = react;
