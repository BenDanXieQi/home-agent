import type { ComponentProps } from "react";

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  return (
    <button className={`button button-${variant} ${className}`} {...props} />
  );
}
