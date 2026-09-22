import { Chip } from "../components";
import { THEME_PREFERENCES, useTheme } from "../theme";

/** The same local preference control is used by the Mac app and the paired phone. */
export function ThemeChoice({ touch = false }: { touch?: boolean }) {
  const theme = useTheme();
  return (
    <span role="group" aria-label="color theme" style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      {THEME_PREFERENCES.map((preference) => (
        <Chip key={preference} label touch={touch} active={theme.preference === preference} aria-pressed={theme.preference === preference} onClick={() => theme.setPreference(preference)}>
          {preference}
        </Chip>
      ))}
    </span>
  );
}
