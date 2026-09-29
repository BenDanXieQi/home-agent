import { DeviceList, DeviceRow } from "./DeviceList";
import { Skeleton } from "../../components/Skeleton";

/** Same grid and row height as `DeviceBrowser` rows, so real rows replace it in place. */
export function DeviceRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return Array.from({ length: rows }, (_, index) => (
    <DeviceRow key={index} aria-hidden="true">
      <div className="flex min-w-0 items-center gap-3">
        <Skeleton className="size-8 rounded-2xl" />
        <strong className="truncate text-sm font-medium max-md:text-[14px] max-md:whitespace-normal max-md:wrap-anywhere max-md:leading-[1.5]">
          <Skeleton className="my-[0.2lh] h-[0.6lh] w-28" />
        </strong>
      </div>
      <Skeleton className="truncate font-mono text-xs text-muted max-md:hidden h-3 w-24" />
      <Skeleton className="h-3 w-10" />
      <span />
    </DeviceRow>
  ));
}

/** Filters, heading and rows of `DeviceBrowser` while its code or data is loading. */
export function DeviceBrowserSkeleton() {
  return (
    <output className="block" aria-label="正在读取设备">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 max-md:items-stretch">
        <Skeleton className="h-7 w-72 rounded-md" />
        <Skeleton className="h-8 w-60 max-md:w-full" />
      </div>
      <DeviceList>
        <DeviceRowsSkeleton />
      </DeviceList>
    </output>
  );
}
