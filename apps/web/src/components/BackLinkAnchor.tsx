import { ArrowLeft } from "lucide-react";
import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";
import { buttonStyles } from "./button-styles";

export function BackLinkAnchor({
  children = "返回",
  className,
  ...props
}: ComponentProps<"a">) {
  return (
    <a
      {...props}
      draggable={false}
      className={twMerge(
        buttonStyles.base,
        buttonStyles.ghost,
        "w-fit justify-self-start rounded-[10px] border-0 px-2 font-normal hover:bg-surface hover:text-ink active:bg-ink/5 active:text-ink focus-visible:outline-2",
        className,
      )}
    >
      <ArrowLeft size={14} className="shrink-0" aria-hidden="true" />
      {children}
    </a>
  );
}
