import { buttonStyles } from "./button-styles";
import { twMerge } from "tailwind-merge";

import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { iconSwap, useFittedSize } from "../utils/motion";

const buttonVariants = {
  primary: `${buttonStyles.primary} button-primary data-[status=error]:border-danger data-[status=error]:bg-danger data-[status=error]:text-white enabled:hover:bg-ink/85`,
  secondary: `${buttonStyles.secondary} enabled:hover:bg-sidebar`,
  ghost: `${buttonStyles.ghost} enabled:hover:bg-sidebar enabled:hover:text-ink`,
};

const buttonSizes = {
  default: { control: "", icon: "size-9 min-w-9 p-0" },
  small: { control: "min-h-8 px-3 py-1.5 text-xs", icon: "size-8 min-w-8 p-0" },
};

/**
 * One glyph for the whole operation, so it transforms instead of swapping: the
 * spinner's arc draws in, shrinks to a dot on completion, and the check or the
 * alert mark draws out of it. Strokes match Lucide icons.
 */
function StatusGlyph({ status }: { status: "pending" | "success" | "error" }) {
  const reduced = useReducedMotion();
  const settle = { duration: 0.22, ease: "easeOut", delay: 0.12 } as const;
  return (
    <svg
      width="1.15em"
      height="1.15em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <m.circle
        cx={12}
        cy={12}
        r={9}
        initial={{ pathLength: status === "pending" ? 0.72 : 0, rotate: 0 }}
        animate={{
          pathLength: status === "pending" ? 0.72 : 0,
          opacity: status === "pending" ? 1 : 0,
          rotate: status === "pending" && !reduced ? 360 : 0,
        }}
        transition={{
          pathLength: { duration: 0.24, ease: "easeOut" },
          opacity: { duration: 0.1, delay: status === "pending" ? 0 : 0.12 },
          rotate: {
            duration: 0.9,
            ease: "linear",
            repeat: status === "pending" && !reduced ? Infinity : 0,
          },
        }}
      />
      <m.path
        d="M20 6 9 17l-5-5"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={
          status === "success"
            ? { pathLength: 1, opacity: 1 }
            : { pathLength: 0, opacity: 0 }
        }
        transition={settle}
      />
      {/* The alert mark draws in two strokes, the dot a beat after the bar. */}
      <m.path
        d="M12 7v6"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={
          status === "error"
            ? { pathLength: 1, opacity: 1 }
            : { pathLength: 0, opacity: 0 }
        }
        transition={settle}
      />
      <m.path
        d="M12 17h.01"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={
          status === "error"
            ? { pathLength: 1, opacity: 1 }
            : { pathLength: 0, opacity: 0 }
        }
        transition={{ ...settle, delay: settle.delay + 0.1 }}
      />
    </svg>
  );
}

// Labels stay sharp and stationary while the button's surface changes size.
const labelSwap = {
  initial: { opacity: 0 },
  animate: {
    opacity: 1,
    transition: { duration: 0.2, delay: 0.06, ease: "easeOut" },
  },
  exit: { opacity: 0, transition: { duration: 0.16, ease: "easeIn" } },
} as const;

/**
 * Shows an operation's outcome only after this button has watched it run, then
 * settles back to idle. A result that was already settled on mount stays quiet.
 */
function useStatusFeedback(status: "idle" | "pending" | "success" | "error") {
  const [previous, setPrevious] = useState(status);
  const [settled, setSettled] = useState<"success" | "error" | null>(null);
  if (status !== previous) {
    setPrevious(status);
    setSettled(
      previous === "pending" && (status === "success" || status === "error")
        ? status
        : null,
    );
  }
  useEffect(() => {
    if (!settled) return undefined;
    const timer = setTimeout(() => setSettled(null), 1400);
    return () => clearTimeout(timer);
  }, [settled]);
  return status === "pending" ? status : (settled ?? "idle");
}

/**
 * Ordinary operations keep their label and show only pending feedback.
 * A result morph is explicitly chosen for a committed action such as saving.
 */
export function Button({
  variant = "secondary",
  size = "default",
  status = "idle",
  feedback = "pending",
  icon,
  className = "",
  style,
  ref,
  children,
  ...props
}: Omit<ComponentProps<typeof m.button>, "children"> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: keyof typeof buttonSizes;
  status?: "idle" | "pending" | "success" | "error";
  feedback?: "pending" | "result";
  icon?: ReactNode;
  children?: ReactNode;
}) {
  const content = useRef<HTMLSpanElement>(null);
  const shown = useStatusFeedback(
    feedback === "result" || status === "pending" ? status : "idle",
  );
  const disabled = shown === "pending" || props.disabled;
  const busy = shown !== "idle";
  const compact = feedback === "result" && busy;
  const [pendingVisible, setPendingVisible] = useState(false);
  const [pendingPhase, setPendingPhase] = useState(shown);
  if (pendingPhase !== shown) {
    setPendingPhase(shown);
    setPendingVisible(false);
  }
  useEffect(() => {
    if (shown !== "pending") return undefined;
    const timer = setTimeout(() => setPendingVisible(true), 150);
    return () => clearTimeout(timer);
  }, [shown]);
  const showPending = shown === "pending" && pendingVisible;
  const { width, radius } = useFittedSize(content, compact);
  const reduced = useReducedMotion();
  const label =
    children !== undefined && children !== null && children !== ""
      ? children
      : null;
  return (
    <m.button
      className={twMerge(
        `${buttonStyles.base} aria-busy:cursor-progress aria-busy:opacity-100 [&:not(.button-primary)[data-status='success']]:text-sage data-[status=error]:border-danger/30 data-[status=error]:bg-danger/5 data-[status=error]:text-danger data-[status=error]:border-dashed ${buttonVariants[variant]} ${buttonSizes[size].control} ${label === null ? buttonSizes[size].icon : ""} ${className}`,
      )}
      data-status={busy ? shown : undefined}
      aria-busy={shown === "pending" || undefined}
      {...props}
      whileHover={disabled ? {} : (props.whileHover ?? {})}
      whileTap={disabled || reduced ? {} : (props.whileTap ?? { scale: 0.98 })}
      disabled={disabled}
      ref={ref}
      style={{ width, borderRadius: radius, ...style }}
    >
      <span
        ref={content}
        className="relative inline-flex flex-none items-center justify-center gap-1.5 whitespace-nowrap"
      >
        {feedback === "pending" ? (
          icon || showPending ? (
            <span className="inline-flex shrink-0 items-center justify-center">
              {showPending ? <StatusGlyph status="pending" /> : icon}
            </span>
          ) : null
        ) : (
          <AnimatePresence mode="popLayout" initial={false}>
            {busy || icon ? (
              <m.span
                key={busy ? "status" : "icon"}
                className="inline-flex shrink-0"
                {...iconSwap}
              >
                {busy ? <StatusGlyph status={shown} /> : icon}
              </m.span>
            ) : null}
          </AnimatePresence>
        )}
        <AnimatePresence mode="popLayout" initial={false}>
          {!compact && label !== null ? (
            <m.span key="label" {...labelSwap}>
              {label}
            </m.span>
          ) : null}
        </AnimatePresence>
      </span>
      {/* The circle hides the label visually; assistive tech keeps the name. */}
      {compact && label !== null ? (
        <span className="sr-only">{label}</span>
      ) : null}
    </m.button>
  );
}
