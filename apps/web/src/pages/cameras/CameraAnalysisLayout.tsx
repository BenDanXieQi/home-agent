import type { ReactNode } from "react";

export function CameraAnalysisLayout({
  children,
  sidebar,
  sidebarLabel,
}: {
  children: ReactNode;
  sidebar: ReactNode;
  sidebarLabel: string;
}) {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div className="min-w-0">{children}</div>
      <aside aria-label={sidebarLabel} className="min-w-0 space-y-3">
        {sidebar}
      </aside>
    </div>
  );
}
