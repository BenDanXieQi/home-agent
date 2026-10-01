import { twMerge } from "tailwind-merge";
import { useId, type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { Ellipsis } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { BackendStatus } from "./BackendStatus";
import { SelectionIndicator } from "../../components/SelectionIndicator";
import { navigation } from "../../navigation";
import { useMobileWorkspace } from "./use-mobile-workspace";
function navigationItemClassName(to: string, selected: boolean) {
  return twMerge(
    `group/navigation-item relative isolate flex h-11 items-center gap-3 rounded-xl px-3.5 text-[13px] text-muted hover:bg-black/4 hover:text-ink transition-[background-color,color] duration-160 ease-[ease] aria-[current=page]:bg-transparent aria-[current=page]:font-medium aria-[current=page]:text-white aria-[current=page]:hover:bg-transparent aria-[current=page]:hover:text-white max-md:h-12 max-md:min-w-0 max-md:flex-1 max-md:flex-col max-md:justify-center max-md:gap-1 max-md:rounded-xl max-md:px-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink max-md:text-[11px] ${to === "/settings" ? "mt-auto mb-2 max-md:m-0" : ""}`,
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
  const mobile = useMobileWorkspace();
  const secondaryNavigation = navigation.filter((item) => !item.mobilePrimary);
  const secondarySelected = secondaryNavigation.some(
    ({ to }) => path === to || path.startsWith(`${to}/`),
  );
  return (
    <>
      {navigation.map(({ to, label, icon: Icon, mobilePrimary }) => {
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
            className={twMerge(
              navigationItemClassName(to, false),
              !mobilePrimary && "max-md:hidden",
            )}
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
            <span className="whitespace-nowrap">{label}</span>
          </Link>
        );
        if (loading)
          return (
            <span
              key={to}
              className={twMerge(
                navigationItemClassName(to, path === to),
                !mobilePrimary && "max-md:hidden",
              )}
            >
              <Icon size={18} strokeWidth={1.65} className="shrink-0" />
              <span className="whitespace-nowrap">{label}</span>
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
      {mobile ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              disabled={loading}
              className={twMerge(
                navigationItemClassName("more", secondarySelected),
                "hidden max-md:flex",
              )}
              aria-label="更多页面"
            >
              <Ellipsis size={18} strokeWidth={1.65} aria-hidden="true" />
              <span>更多</span>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="top"
              align="end"
              sideOffset={12}
              className="z-40 min-w-44 max-h-[60dvh] overflow-y-auto rounded-2xl border border-black/5 bg-white p-2 shadow-panel md:hidden"
            >
              {secondaryNavigation.map(({ to, label, icon: Icon }) => {
                const selected = path === to || path.startsWith(`${to}/`);
                const menuLink = (
                  statusIndicator?: ReactNode,
                  statusHint?: string,
                ) => (
                  <DropdownMenu.Item key={to} asChild disabled={path === to}>
                    <Link
                      to={to}
                      activeOptions={{ exact: false }}
                      activeProps={{
                        className: path === to ? "pointer-events-none" : "",
                      }}
                      aria-label={
                        statusHint ? `${label}，${statusHint}` : label
                      }
                      className={twMerge(
                        "flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm outline-none",
                        selected
                          ? "bg-ink text-white data-highlighted:bg-ink data-highlighted:text-white"
                          : "text-muted data-highlighted:bg-black/4 data-highlighted:text-ink",
                        path === to && "pointer-events-none",
                      )}
                    >
                      <Icon size={18} strokeWidth={1.65} aria-hidden="true" />
                      <span>{label}</span>
                      {statusIndicator}
                    </Link>
                  </DropdownMenu.Item>
                );
                return to === "/settings" ? (
                  <BackendStatus key={to}>{menuLink}</BackendStatus>
                ) : (
                  menuLink()
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
    </>
  );
}
