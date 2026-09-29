import { useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, type ComponentProps } from "react";

import { useComposedRef } from "../utils/use-composed-ref";

/** Reveal a heading and its metadata together without retaining old content. */
export function TextReveal({
  children,
  changeKey,
  className,
  ref,
  ...props
}: Omit<ComponentProps<"div">, "dangerouslySetInnerHTML"> & {
  changeKey: string;
}) {
  const content = useRef<HTMLDivElement>(null);
  const composedRef = useComposedRef(content, ref);
  const reducedMotion = useReducedMotion();
  useLayoutEffect(() => {
    if (reducedMotion) return undefined;
    const animation = content.current?.animate(
      [{ transform: "translateY(5px)" }, { transform: "translateY(0)" }],
      { duration: 180, easing: "ease-out" },
    );
    return () => animation?.cancel();
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Replay only when the heading context changes, not on live count updates.
    changeKey,
    reducedMotion,
  ]);
  return (
    <div className="min-w-0 max-w-full overflow-hidden">
      <div {...props} ref={composedRef} className={className}>
        {children}
      </div>
    </div>
  );
}
