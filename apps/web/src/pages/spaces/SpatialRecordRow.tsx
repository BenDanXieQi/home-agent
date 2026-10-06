import type { ReactNode } from "react";

export function SpatialRecordRow({
  id,
  icon,
  name,
  detail,
  description,
  actions,
}: {
  id: string;
  icon: ReactNode;
  name: string;
  detail?: ReactNode;
  description: string;
  actions: ReactNode;
}) {
  return (
    <article className="grid min-w-0 grid-cols-[36px_minmax(0,1fr)] gap-x-3 gap-y-3 rounded-xl bg-white px-4 py-4 sm:grid-cols-[36px_minmax(0,1fr)_auto] sm:px-5">
      <span
        className="grid size-9 place-items-center rounded-lg bg-surface text-muted"
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <h2
          className="break-words text-[13px] font-medium leading-5"
          title={id}
        >
          {name}
        </h2>
        {detail ? (
          <div className="mt-1 text-xs leading-5 text-muted">{detail}</div>
        ) : null}
        {description ? (
          <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-6 text-muted">
            {description}
          </p>
        ) : null}
      </div>
      <div className="col-start-2 flex flex-wrap items-center gap-1 sm:col-start-3 sm:row-start-1">
        {actions}
      </div>
    </article>
  );
}
