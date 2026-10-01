import type { ReactNode } from "react";

/** Shared geometry for live, unavailable and loading camera headings. */
export function CameraHeader({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-18 items-center justify-between gap-3 bg-white px-4 py-3 text-ink">
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
