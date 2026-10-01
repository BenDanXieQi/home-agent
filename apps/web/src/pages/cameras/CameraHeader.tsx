import type { ReactNode } from "react";
import { twMerge } from "tailwind-merge";

/** Shared geometry for live, unavailable and loading camera headings. */
export function CameraHeader({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={twMerge(
        "flex min-h-18 items-center justify-between gap-3 bg-white py-3 pl-4 pr-1.5 text-ink",
        className,
      )}
    >
      <h2
        className="min-w-0 flex-1 line-clamp-2 text-sm leading-5 font-medium"
        title={typeof title === "string" ? title : undefined}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}
