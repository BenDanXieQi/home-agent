import type { ComponentProps, ReactNode } from "react";
import { twMerge } from "tailwind-merge";

const columns =
  "grid grid-cols-[minmax(160px,1.5fr)_minmax(100px,1fr)_70px_24px] items-center gap-5 max-md:grid-cols-[minmax(100px,_1fr)_52px_24px] max-md:gap-2 max-md:px-3";

export function DeviceList({
  showHeader = true,
  children,
}: {
  showHeader?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="relative w-full overflow-hidden rounded-2xl bg-surface p-2">
      {showHeader ? (
        <div className={`${columns} h-11 px-5 text-xs text-muted`}>
          <span>设备名称</span>
          <span className="max-md:hidden">最近状态</span>
          <span>状态</span>
          <span className="max-md:hidden" />
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function DeviceRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={twMerge(
        columns,
        "min-h-[72px] mb-1 rounded-xl bg-white px-4 py-3 shadow-surface last:mb-0 max-md:[&>span:empty]:hidden",
        className,
      )}
    />
  );
}
