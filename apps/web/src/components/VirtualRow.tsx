import { twMerge } from "tailwind-merge";
import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { m, useIsPresent } from "motion/react";

import { useComposedRef } from "../utils/use-composed-ref";

/** Virtual positioning owns top; Motion owns only the visible filter transition. */
export function VirtualRow({
  id,
  index,
  top,
  gap = 0,
  membership,
  entering,
  onSize,
  children,
  className = "",
  style,
  ref,
  ...props
}: Omit<ComponentProps<typeof m.div>, "dangerouslySetInnerHTML"> & {
  id: string;
  index: number;
  top: number;
  gap?: number;
  membership: string;
  entering: boolean;
  onSize: (index: number, height: number) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const composedRef = useComposedRef(element, ref);
  const present = useIsPresent();
  useLayoutEffect(() => {
    const row = element.current;
    if (!row || !present) return undefined;
    const measure = () => onSize(index, row.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [index, present, onSize]);
  return (
    <m.div
      {...props}
      ref={composedRef}
      data-virtual-row={id}
      className={twMerge(`absolute left-0 flow-root w-full ${className}`)}
      style={{
        ...style,
        top,
        paddingBottom: gap,
        pointerEvents: present ? undefined : "none",
      }}
      inert={!present}
      layout="position"
      layoutDependency={membership}
      initial={entering ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      exit="removed"
      variants={{
        removed: (keys: Set<string>) => ({
          opacity: keys.has(id) ? 1 : 0,
          transition: { duration: keys.has(id) ? 0 : 0.16 },
        }),
      }}
    >
      {children}
    </m.div>
  );
}
