import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names the way shadcn's components expect: falsy parts drop out, and a later Tailwind class wins over an
 * earlier one for the same property, so a caller's `className` can override a component's default.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
