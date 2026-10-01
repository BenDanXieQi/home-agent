import { twMerge } from "tailwind-merge";
import { useId, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { BackendStatus } from "./BackendStatus";
import { SelectionIndicator } from "../../components/SelectionIndicator";
import { navigation } from "../../navigation";
function navigationItemClassName(to: string, selected: boolean) {
  return twMerge(
    `group/navigation-item relative isolate flex h-11 items-center gap-3 rounded-xl px-3.5 text-[13px] text-muted hover:bg-black/4 hover:text-ink transition-[background-color,color] duration-160 ease-[ease] aria-[current=page]:bg-transparent aria-[current=page]:font-medium aria-[current=page]:text-white aria-[current=page]:hover:bg-transparent aria-[current=page]:hover:text-white max-md:h-12 max-md:min-w-0 max-md:flex-1 max-md:flex-col max-md:justify-center max-md:gap-1 max-md:rounded-xl max-md:px-1 max-md:text-[11px] ${to === "/settings" ? "mt-auto mb-2 max-md:m-0" : ""}`,
    selected && "bg-ink font-medium text-white hover:bg-ink hover:text-white",
  );
}

export function WorkspaceNavigation({
  path,
  loading = false,
  capabilityFailures = 0,
}: {
  path: string;
  loading?: boolean;
  capabilityFailures?: number;
}) {
  const selectionId = useId();
  return (
    <>
      {navigation.map(({ to, label, icon: Icon }) => {
        const link = (statusIndicator?: ReactNode, statusHint?: string) => (
          <Link
            key={to}
            to={to}
            aria-label={
              statusHint
                ? `${label}，${statusHint}`
                : to === "/devices" && capabilityFailures
                  ? `${label}，${capabilityFailures} 台设备能力获取失败`
                  : label
            }
            title={
              to === "/devices" && capabilityFailures
                ? `${capabilityFailures} 台设备能力获取失败，点击查看`
                : undefined
            }
            draggable={false}
            activeOptions={{ exact: false }}
            className={navigationItemClassName(to, false)}
            activeProps={{
              className: path === to ? "pointer-events-none" : "",
            }}
          >
            {path === to || path.startsWith(`${to}/`) ? (
              <SelectionIndicator
                layoutId={selectionId}
                className="inset-0 rounded-xl"
              />
            ) : null}
            <span
              className={twMerge(
                `relative inline-flex shrink-0 ${statusHint ? "motion-safe:animate-[nav-attention_6s_ease-in-out_infinite]" : ""}`,
              )}
            >
              <Icon size={18} strokeWidth={1.65} className="shrink-0" />
              {statusIndicator ? (
                <span className="absolute -right-1 -top-1 flex rounded-full ring-2 ring-white group-aria-[current=page]/navigation-item:ring-ink">
                  {statusIndicator}
                </span>
              ) : null}
            </span>
            <span>{label}</span>
          </Link>
        );
        if (loading)
          return (
            <span key={to} className={navigationItemClassName(to, path === to)}>
              <Icon size={18} strokeWidth={1.65} className="shrink-0" />
              <span>{label}</span>
            </span>
          );
        return to === "/settings" ? (
          <BackendStatus key={to}>{link}</BackendStatus>
        ) : (
          link(
            to === "/devices" && capabilityFailures ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-amber-500"
                aria-hidden="true"
              />
            ) : undefined,
          )
        );
      })}
    </>
  );
}
