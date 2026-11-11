import { createCn } from "cn/config";

/**
 * Joins class names and lets a later Tailwind class win over an earlier one of its kind, as shadcn's `cn()` does, taught
 * loki's own scale names (styles.css `@theme inline`). Without them `text-body` reads as a text colour and drops
 * `text-primary-foreground` beside it, and `shadow-float` as a shadow colour; with them a size and a colour both stay.
 * Lives where components.json's `utils` alias points, so components added by the shadcn CLI import it as they are.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["micro", "fine", "tag", "meta", "body", "row", "card", "display", "hero"] }],
      shadow: [{ shadow: ["sheet", "float", "panel", "low"] }],
    },
  },
});
