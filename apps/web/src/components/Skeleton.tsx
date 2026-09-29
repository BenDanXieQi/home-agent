import { twMerge } from "tailwind-merge";
import type { ComponentProps } from "react";

const tones = { light: "bg-linen", dark: "bg-white/8" };

/**
 * Placeholder with the shape of content that has not arrived; it never moves
 * layout. Size it with `lh` units inside real text elements so a placeholder
 * line is exactly as tall as the text that replaces it.
 */
export function Skeleton({
  className = "",
  tone = "light",
  ...props
}: Omit<ComponentProps<"span">, "children" | "dangerouslySetInnerHTML"> & {
  tone?: keyof typeof tones;
}) {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={twMerge(
        `block animate-skeleton rounded motion-reduce:animate-none ${tones[tone]} ${className}`,
      )}
    />
  );
}
