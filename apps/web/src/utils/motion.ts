import { animate, useMotionValue, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, type RefObject } from "react";

/** Structural changes have time to read, with a finite finish and no bounce. */
export const spring = {
  type: "spring",
  duration: 0.34,
  bounce: 0,
} as const;

/** Content updates remain sharp; a quiet crossfade communicates replacement. */
export const contentSwap = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2, ease: "easeOut" } },
  exit: { opacity: 0, transition: { duration: 0.16, ease: "easeIn" } },
} as const;

export const iconSwap = {
  initial: { opacity: 0, scale: 0.94 },
  animate: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.22, ease: "easeOut" },
  },
  exit: { opacity: 0, scale: 0.94, transition: { duration: 0.16 } },
} as const;

/** Height morphs for panels that open in place and push surrounding content. */
export const expand = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1, transition: spring },
  exit: {
    height: 0,
    opacity: 0,
    transition: { ...spring, opacity: { duration: 0.18 } },
  },
} as const;

const px = (value: string) => Number.parseFloat(value) || 0;
const roundOff = { type: "spring", duration: 0.2, bounce: 0 } as const;

/**
 * Springs the parent of `content` to fit it, so container morphs change real
 * dimensions and text never scales. With `circle`, the parent instead becomes
 * a circle as tall as it is: width and radius spring from wherever they are.
 * Width and height are `auto` until the first measurement.
 */
export function useFittedSize(
  content: RefObject<HTMLElement | null>,
  circle = false,
) {
  const width = useMotionValue<number | string>("auto");
  const height = useMotionValue<number | string>("auto");
  const radius = useMotionValue<number | string>("");
  const reduced = useReducedMotion();
  const fit = useRef({
    placed: false,
    baseRadius: 0,
    circle,
    size: null as ResizeObserverSize | null,
    apply: (_instant: boolean) => {},
  });
  useLayoutEffect(() => {
    const element = content.current;
    const box = element?.parentElement;
    if (!element || !box) return undefined;
    const state = fit.current;
    state.apply = (instant) => {
      const size = state.size;
      if (!size) return;
      const style = getComputedStyle(box);
      if (!state.placed) state.baseRadius = px(style.borderTopLeftRadius);
      const fittedWidth =
        size.inlineSize +
        px(style.paddingLeft) +
        px(style.paddingRight) +
        px(style.borderLeftWidth) +
        px(style.borderRightWidth);
      const fittedHeight =
        size.blockSize +
        px(style.paddingTop) +
        px(style.paddingBottom) +
        px(style.borderTopWidth) +
        px(style.borderBottomWidth);
      const side = box.offsetHeight;
      const nextWidth = state.circle ? side : fittedWidth;
      const nextRadius = state.circle ? side / 2 : state.baseRadius;
      if (instant || !state.placed || reduced) {
        state.placed = true;
        width.jump(nextWidth);
        height.jump(fittedHeight);
        radius.jump(nextRadius);
        return;
      }
      animate(width, nextWidth, spring);
      animate(height, fittedHeight, spring);
      // Stay round throughout: corners round off before the width contracts,
      // and relax only once the width has mostly grown back.
      animate(
        radius,
        nextRadius,
        state.circle ? roundOff : { ...spring, delay: 0.04 },
      );
    };
    const observer = new ResizeObserver(([entry]) => {
      const [size] = entry?.borderBoxSize ?? [];
      if (!size) return;
      state.size = size;
      state.apply(false);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [content, reduced, width, height, radius]);
  useLayoutEffect(() => {
    if (fit.current.circle === circle) return;
    fit.current.circle = circle;
    fit.current.apply(false);
  }, [circle]);
  return { width, height, radius };
}
