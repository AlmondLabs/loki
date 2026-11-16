import { Icon as SharedIcon, type IconProps } from "../shared/icons";

export type { IconName, IconProps } from "../shared/icons";

export function Icon({ className, ...rest }: IconProps) {
  return <SharedIcon className={className ? `loki-phone-icon ${className}` : "loki-phone-icon"} {...rest} />;
}
