import {
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { House } from "lucide-react";
import { TextReveal } from "../../components/TextReveal";
import { navigation } from "../../navigation";

export function WorkspaceHeader({
  path,
  brand,
  detailsRef,
  actionsRef,
  children,
}: {
  path: string;
  brand?: ReactNode;
  children?: ReactNode;
  detailsRef?: ComponentProps<"div">["ref"];
  actionsRef?: ComponentProps<"div">["ref"];
}) {
  const current = navigation.find(
    (item) => item.to === path || path.startsWith(`${item.to}/`),
  );
  const PageIcon = current?.icon ?? House;
  const reducedMotion = useReducedMotion();
  const header = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = header.current;
    const workspace = element?.parentElement;
    if (!element || !workspace) return undefined;
    const updateHeight = () => {
      workspace.style.setProperty(
        "--workspace-header-height",
        `${element.getBoundingClientRect().height}px`,
      );
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element, { box: "border-box" });
    return () => {
      observer.disconnect();
      workspace.style.removeProperty("--workspace-header-height");
    };
  }, []);
  return (
    <header
      ref={header}
      className="sticky top-0 z-10 flex min-h-16 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 bg-paper px-4 py-3 [&_h1]:text-[18px] [&_h1]:font-semibold [&_h1]:tracking-tight max-md:gap-2 max-md:[&_h1]:text-lg"
    >
      <div className="flex min-w-0 items-center gap-2">
        {brand}
        <div
          className="grid size-6 shrink-0 place-items-center text-ink/75 motion-safe:animate-[heading-icon-enter_180ms_ease-out] max-md:hidden"
          aria-hidden="true"
        >
          <AnimatePresence initial={false}>
            <m.span
              key={current?.to ?? "workspace"}
              className="col-start-1 row-start-1 inline-flex"
              initial={
                reducedMotion
                  ? false
                  : {
                      opacity: 0.35,
                      transform: "translateY(5px) rotate(-50deg) scale(0.6)",
                    }
              }
              animate={{
                opacity: 1,
                transform: reducedMotion
                  ? "translateY(0px) rotate(0deg) scale(1)"
                  : [
                      null,
                      "translateY(-1px) rotate(7deg) scale(1.08)",
                      "translateY(0px) rotate(0deg) scale(1)",
                    ],
              }}
              exit={{
                opacity: 0,
                transform: reducedMotion
                  ? "none"
                  : "translateY(-2px) rotate(15deg) scale(0.8)",
                transition: { duration: reducedMotion ? 0 : 0.08 },
              }}
              transition={{
                duration: reducedMotion ? 0 : 0.26,
                times: [0, 0.7, 1],
                ease: [0.25, 0.46, 0.45, 0.94],
                opacity: { duration: reducedMotion ? 0 : 0.06 },
              }}
            >
              <PageIcon size={20} strokeWidth={1.8} />
            </m.span>
          </AnimatePresence>
        </div>
        <TextReveal
          changeKey={current?.to ?? "workspace"}
          className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2"
        >
          <h1>
            {path === "/members/new"
              ? "添加成员"
              : current?.to === "/members"
                ? "家庭成员"
                : (current?.label ?? "Home Agent")}
          </h1>
          <div
            className="flex min-w-0 items-center empty:hidden max-md:max-w-40"
            ref={detailsRef}
          />
        </TextReveal>
      </div>
      <div
        className="ml-auto flex min-w-0 items-center gap-3 empty:hidden max-md:flex-wrap"
        ref={actionsRef}
      />
      {children}
    </header>
  );
}
