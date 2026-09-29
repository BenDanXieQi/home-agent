import { Skeleton } from "./Skeleton";
import { useContext, type PropsWithChildren, type ContextType } from "react";
import { createPortal } from "react-dom";
import { PageHeaderContext } from "./page-header-context";

// Routes own their controls; the shell only provides their shared placement.
export function PageHeaderContent({
  slot,
  children,
}: PropsWithChildren<{
  slot: keyof ContextType<typeof PageHeaderContext>;
}>) {
  const target = useContext(PageHeaderContext)[slot];
  return target ? createPortal(children, target) : null;
}

export function PageHeaderCount({
  count,
  loading,
  label,
}: {
  count: number | null;
  loading: boolean;
  label: string;
}) {
  return (
    <PageHeaderContent slot="details">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
        {count !== null ? (
          <span className="shrink-0 whitespace-nowrap tabular-nums">
            {count} 台{label}
          </span>
        ) : loading ? (
          <Skeleton className="h-5 w-20" />
        ) : null}
      </div>
    </PageHeaderContent>
  );
}
