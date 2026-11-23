import { createCn } from "cn/config";

// Outside (Tailwind): an unknown `shadow-float` reads as a shadow colour and survives beside `shadow-low`, so the merge is
// taught loki's shadow names (styles.css `@theme inline`).
// Outside (shadcn): components the CLI adds import `cn` from components.json's `utils` alias, which points here.
export const cn = createCn({
  extend: {
    classGroups: {
      shadow: [{ shadow: ["sheet", "float", "panel", "low"] }],
    },
  },
});
