"use client";

import { cn } from "@/lib/utils";
import { type CSSProperties, type ElementType, memo } from "react";

// loki: drawn with shadcn's `shimmer` utility (shadcn/tailwind.css) instead of motion, which this one component
// would have added to the bundle on its own. The utility stops under reduced motion.
export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
}

const ShimmerComponent = ({ children, as: Component = "p", className, duration = 2 }: TextShimmerProps) => (
  <Component className={cn("shimmer inline-block", className)} style={{ "--shimmer-duration": `${duration}s` } as CSSProperties}>
    {children}
  </Component>
);

export const Shimmer = memo(ShimmerComponent);
