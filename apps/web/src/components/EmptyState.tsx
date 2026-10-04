import { twMerge } from "tailwind-merge";
import type { ComponentProps, ReactNode } from "react";

const surfaces = {
  card: "rounded-xl bg-white shadow-surface",
  plain: "bg-transparent",
};
const layouts = {
  compact: "",
  stable: "w-full",
};

/** A quiet content surface with one explanation and one next step. */
export function EmptyState({
  icon,
  title,
  description,
  children,
  className = "",
  surface = "card",
  layout = "compact",
  ...props
}: Omit<ComponentProps<"div">, "title" | "dangerouslySetInnerHTML"> & {
  surface?: keyof typeof surfaces;
  layout?: keyof typeof layouts;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div
      {...props}
      className={twMerge(
        "empty-state grid min-h-64 place-items-center px-8 py-10 max-[601px]:px-6 max-[601px]:py-8",
        surfaces[surface],
        className,
      )}
    >
      <div
        className={`flex max-w-xl items-start gap-5 max-[601px]:flex-col max-[601px]:gap-4 ${layouts[layout]}`}
      >
        <span
          className="grid size-14 shrink-0 place-items-center self-start rounded-2xl bg-surface text-ink"
          aria-hidden="true"
        >
          {icon}
        </span>
        <div
          className={`min-w-0 max-w-md ${layout === "stable" ? "flex-1" : ""}`}
        >
          <h2 className="text-base font-semibold leading-7 text-ink">
            {title}
          </h2>
          <p className="mt-2 text-sm leading-7 text-muted">{description}</p>
          {children ? (
            <div className="mt-5 flex flex-wrap gap-3">{children}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
