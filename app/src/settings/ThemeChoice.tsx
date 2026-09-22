import { Chip } from "../components";
import { PALETTES, PALETTE_LABEL, THEME_PREFERENCES, useTheme } from "../theme";

/** The same local control is used by the Mac app and the paired phone: day or night, then the colour family. */
export function ThemeChoice({ touch = false }: { touch?: boolean }) {
  const theme = useTheme();
  return (
    <span style={{ display: "inline-flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
      <span role="group" aria-label="light or dark" style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
        {THEME_PREFERENCES.map((preference) => (
          <Chip key={preference} label touch={touch} active={theme.preference === preference} aria-pressed={theme.preference === preference} onClick={() => theme.setPreference(preference)}>
            {preference}
          </Chip>
        ))}
      </span>
      <span role="group" aria-label="colour palette" style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
        {PALETTES.map((palette) => (
          <Chip key={palette} label touch={touch} active={theme.palette === palette} aria-pressed={theme.palette === palette} onClick={() => theme.setPalette(palette)}>
            {PALETTE_LABEL[palette]}
          </Chip>
        ))}
      </span>
    </span>
  );
}
