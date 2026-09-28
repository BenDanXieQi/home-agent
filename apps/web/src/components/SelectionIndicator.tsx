import { twMerge } from "tailwind-merge";
import type { ComponentProps } from "react";
import { m, useIsPresent, useReducedMotion } from "motion/react";

/** Render inside the selected item; Motion owns measurement and shared layout. */
export function SelectionIndicator({
  layoutId,
  className = "",
  ...props
}: Omit<
  ComponentProps<typeof m.span>,
  "children" | "dangerouslySetInnerHTML"
> & {
  layoutId: string;
}) {
  const reduced = useReducedMotion();
  const present = useIsPresent();
  if (!present) return null;
  return (
    <m.span
      {...props}
      layoutId={layoutId}
      initial={false}
      transition={{ duration: reduced ? 0 : 0.26, ease: [0.32, 0, 0.2, 1] }}
      aria-hidden="true"
      data-selection-indicator
      className={twMerge(
        `pointer-events-none absolute -z-10 bg-ink ${className}`,
      )}
    />
  );
}
