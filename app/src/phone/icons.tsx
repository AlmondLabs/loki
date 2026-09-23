import { Icon as SharedIcon, type IconProps } from "../shared/icons";

/** The icon family moved to shared/icons.tsx for the desktop's Slack chrome; the phone keeps its import and its class. */
export type { IconName, IconProps } from "../shared/icons";

/** One icon, carrying the phone's class too (phone.css sizes and tints it under the phone root). */
export function Icon({ className, ...rest }: IconProps) {
  return <SharedIcon className={className ? `loki-phone-icon ${className}` : "loki-phone-icon"} {...rest} />;
}
