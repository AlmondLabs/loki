import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

// loki (plan 2026-11-15-1035, U1): the Mac's small switch, 16 × 28, the accent when on and the control grey when off (3:1 against the ground, as a control needs).
// Focus is loki's ring (tokens.css, [tabindex]:focus-visible), so the upstream ring classes and outline-none are gone;
// sizes are on Tailwind's steps rather than upstream's 18.4px. The knob is the on-accent white in both themes, as the Mac draws it.
function Switch({ className, size = "default", ...props }: SwitchPrimitive.Root.Props & { size?: "sm" | "default" }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-colors after:absolute after:-inset-x-3 after:-inset-y-2 data-[size=default]:h-4 data-[size=default]:w-7 data-[size=sm]:h-3 data-[size=sm]:w-5 data-checked:bg-primary data-unchecked:bg-input data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-loki-on-affirm shadow-low transition-transform group-data-[size=default]/switch:size-3.5 group-data-[size=sm]/switch:size-2.5 group-data-[size=default]/switch:data-checked:translate-x-3 group-data-[size=sm]/switch:data-checked:translate-x-2 data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
