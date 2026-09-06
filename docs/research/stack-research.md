# loki research — styling, charts, viewport lib

Research for the loki Letta Code mod (runtime-bundled React widgets via esbuild, React + house kit external/host-provided, WS hot-load). Data gathered 2026-09-02 from npm registry, GitHub API, and project docs (search engines were rate-limiting, so primary sources were used directly).

## Q1: Styling for runtime-bundled React modules

**Verdict: CONFIRMED.** "Plain CSS + design-token CSS variables owned by the host page; no Tailwind in authored modules" is exactly the pattern the 2025–2026 generative-UI products converged on.

- **Thesys C1** (the most direct analog — LLM-generated UI rendered into a host app): styling is entirely host-side. Docs structure is Theming → Customizing Charts → "Overriding Styles with CSS", and theme tokens are plain `:root` CSS variables (`--primary: 139 92 246;`, `--gray-50` … `--gray-950`, `--background-dark`, etc.). The model emits component structure; the host owns all visual tokens. https://docs.thesys.dev/guides/styling
- **Vercel AI SDK generative UI**: the model never authors styles at all — it selects/parameterizes pre-built host components (tool results mapped to React components). Styling lives 100% in the host bundle. https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces
- **v0 / shadcn** is the apparent counterexample (generates Tailwind classes), but it only works because v0 output goes through a full Tailwind build step. loki bundles at runtime with esbuild and no CSS pipeline, so Tailwind JIT is unavailable; the Tailwind CDN script is explicitly not-for-production and bloats the host page. Notably, even shadcn's theming layer is CSS variables (`--chart-1`, `--background`, etc.) — Tailwind classes just reference them. https://ui.shadcn.com/docs/theming
- **Pattern worth copying from thesys C1**: publish a documented token sheet (`--loki-bg`, `--loki-fg`, `--loki-accent`, `--loki-chart-1..5`, spacing/radius/font tokens) in the host page, tell the agent (in its widget-authoring prompt) to style via `style={{}}` inline styles + `var(--loki-*)` and the house kit's props, and forbid `<style>` injection except for a scoped escape hatch. This is also how shadcn themes its Recharts charts (per-chart `--color-<series>: var(--chart-n)` indirection — worth copying for series colors).

## Q2: Chart library LLMs generate most reliably (2026)

**Pick: Recharts (v3).**

- **Recharts**: v3.10.1 published 2026-07-25, repo pushed 2026-09-01, 27.5k stars — very active. Declarative JSX composition (`<BarChart><Bar/><XAxis/>`) is the shape LLMs produce most reliably, and it has by far the largest training-data footprint of any React chart lib. https://github.com/recharts/recharts
- It's what the ecosystem standardized on: **shadcn/ui Charts is "Built using Recharts"** and deliberately does not wrap it ("you're not locked into an abstraction"), now on Recharts v3. Since v0/shadcn output dominates LLM fine-tuning corpora, models emit correct Recharts code with high fidelity. https://ui.shadcn.com/docs/components/chart
- **Tremor is out as a dependency**: `@tremor/react` last published 2025-01-13 (dead on npm for ~20 months). Tremor joined Vercel in early 2025 and pivoted to copy-paste components — which are themselves built on Recharts. https://www.npmjs.com/package/@tremor/react
- Nothing newer displaced it: visx/nivo are less LLM-reliable (more API surface / imperative config), and the "new" 2025-26 entrants (e.g. shadcn charts, Tremor's newer kit) are Recharts wrappers.
- **For loki**: mark `recharts` external, provide it as a host global next to React, and expose a thin `ChartContainer` in the house kit that maps series colors to `var(--loki-chart-n)` tokens (shadcn pattern).

## Q3: react-zoom-pan-pinch for widget-desk viewport

**Verdict: KEEP react-zoom-pan-pinch. Actively maintained and the right tool.**

- Maintenance: v4.1.1 published **2026-09-02** (the day of this research); repo pushed same day; 1.9k stars; only 21 open issues. Under the BetterTyped org — clearly alive. https://github.com/BetterTyped/react-zoom-pan-pinch
- Feature fit is exact: programmatic camera API via ref/`useControls` — `zoomToElement(node, scale, animationTime, easing)`, `setTransform(x, y, scale, ...)`, `centerView`, `zoomIn/Out` — i.e., zoom-to-widget is a one-liner. Wheel + pinch + trackpad handled natively (`wheel`, `pinch`, `doubleClick` config objects; trackpad pinch arrives as ctrl+wheel and is handled), plus `velokityAnimation` for inertial panning.
- **use-gesture is not the better pick here**: `@use-gesture/react` last published 2024-03-21, repo last pushed 2024-07-15 (staler than r-z-p-p), and it's a lower-level gesture primitive — you'd hand-roll the transform state, bounds, animation, and zoom-to-element math yourself. Only reach for it if loki later needs per-widget drag gestures beyond what the viewport lib gives.
- No newer credible replacement surfaced; React Flow's viewport is excellent but drags in a whole node-graph framework.
- Note for loki: render widgets inside `<TransformComponent>`, and stopPropagation on wheel events inside scrollable widget bodies so inner scrolling doesn't fight viewport zoom (standard r-z-p-p pattern).

## Recommended stack

1. **Styling**: plain CSS + host-owned `--loki-*` design-token CSS variables (thesys C1 / shadcn-theming pattern); inline styles in authored modules; no Tailwind.
2. **Charts**: Recharts v3 as a host-provided external global, with a house `ChartContainer` mapping series colors to chart tokens.
3. **Viewport**: react-zoom-pan-pinch v4 (actively maintained; `zoomToElement`/`setTransform` for camera moves; native trackpad pinch).
