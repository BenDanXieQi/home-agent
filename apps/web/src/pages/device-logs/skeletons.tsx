import { ChevronDown } from "lucide-react";
import { Skeleton } from "../../components/Skeleton";

export function LogDevicesSkeleton() {
  return Array.from({ length: 7 }, (_, index) => (
    <div
      key={`skeleton-${index}`}
      className="relative isolate flex gap-2.5 items-center w-full text-left p-2.5 border border-transparent rounded-lg bg-transparent cursor-pointer text-ink [&_svg]:shrink-0 [&_svg]:text-muted disabled:opacity-45 disabled:cursor-not-allowed"
      aria-hidden="true"
    >
      <Skeleton className="size-4 rounded-full" />
      <span className="min-w-0 flex-1">
        <strong className="block text-[13px] leading-5 font-medium wrap-anywhere">
          <Skeleton className="my-[0.2lh] h-[0.6lh] w-3/5" />
        </strong>
        <small className="block text-[11px] mt-0.5 text-muted">
          <Skeleton className="my-[0.2lh] h-[0.6lh] w-2/5" />
        </small>
      </span>
    </div>
  ));
}

/** Uses the real event markup, inert, so each placeholder row is exactly as tall. */
export function LogEventsSkeleton() {
  return (
    <output
      className="h-full overflow-auto overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable] px-1 pb-2 block"
      aria-label="正在读取设备日志"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <article
          key={index}
          className="mb-3 rounded-xl bg-white shadow-surface [&_time_small]:block [&_time_small]:text-[11px] [&_time_small]:mt-1.5"
          inert
          aria-hidden="true"
        >
          <div className="grid w-full grid-cols-[56px_minmax(0,1fr)_minmax(100px,auto)_14px] items-center gap-5 px-6 py-5 text-left hover:bg-black/[0.015] max-[1001px]:grid-cols-[minmax(0,1fr)_14px] max-[1001px]:gap-x-4 max-[1001px]:gap-y-2 max-[1001px]:px-5 max-[1001px]:py-4">
            <time className="text-[11px] tabular-nums text-muted shrink-0 pt-0.5 max-[1001px]:col-start-1 max-[1001px]:row-start-1">
              <Skeleton className="h-3 w-12" />
            </time>
            <span className="flex min-w-0 flex-col gap-1 max-[1001px]:col-start-1 max-[1001px]:row-start-2">
              <strong className="text-[15px] font-medium leading-6">
                <Skeleton className="my-1 h-4 w-3/4" />
              </strong>
              <span className="text-xs leading-5 text-muted">
                <Skeleton className="my-1 h-3 w-20" />
              </span>
            </span>
            <span className="flex gap-2.5 items-center text-[14px] [&_code]:text-sm [&_code]:leading-7 [&_code]:wrap-anywhere [&_code]:min-w-0 [&_svg]:shrink-0 [&_svg]:text-muted m-0 max-w-72 flex-wrap justify-end max-[1001px]:col-start-1 max-[1001px]:row-start-3 max-[1001px]:max-w-full max-[1001px]:justify-start">
              <Skeleton className="h-4 w-16" />
            </span>
            <ChevronDown
              size={14}
              className="shrink-0 text-muted transition-transform m-0 max-[1001px]:col-start-2 max-[1001px]:row-start-1"
            />
          </div>
        </article>
      ))}
    </output>
  );
}
