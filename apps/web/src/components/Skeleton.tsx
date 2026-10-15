import { twMerge } from "tailwind-merge";
import type { ComponentProps } from "react";

const tones = { light: "bg-linen", dark: "bg-white/8" };

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
