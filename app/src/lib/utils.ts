import { createCn } from "cn/config";

/**
 * Joins class names and lets a later Tailwind class win over an earlier one of its kind, as shadcn's `cn()` does, taught
 * loki's shadow names (styles.css `@theme inline`). Without them `shadow-float` reads as a shadow colour and survives
 * beside `shadow-low`. Text sizes need no teaching: they are Tailwind's own. Lives where components.json's `utils` alias
 * points, so components added by the shadcn CLI import it as they are.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      shadow: [{ shadow: ["sheet", "float", "panel", "low"] }],
    },
  },
});
