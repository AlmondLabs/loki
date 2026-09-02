// Import-map target for "@loci/kit" in authored modules. Re-exports the host
// kit so authored widgets compose the same components the built-ins use.
const kit = window.__loci_vendor.kit;
export const {
  InfoCard, Stat, SliderControl, ListCard, ChartCard,
} = kit;
