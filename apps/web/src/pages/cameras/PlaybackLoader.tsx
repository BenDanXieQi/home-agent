import { twMerge } from "tailwind-merge";
import type { ComponentProps } from "react";
import { agentHousePath } from "../../components/agent-mark";

/** The mascot's outline carries a moving highlight, without duplicating its face. */
export function PlaybackLoader({
  active,
  className = "",
  ...props
}: Omit<ComponentProps<"span">, "children" | "dangerouslySetInnerHTML"> & {
  active: boolean;
}) {
  return (
    <span
      {...props}
      className={twMerge(`block text-[rgb(255_255_255_/_80%)] ${className}`)}
      aria-hidden="true"
      data-active={active}
    >
      <svg
        className="block w-12 h-12"
        viewBox="12 14 40 40"
        fill="none"
        focusable="false"
      >
        <path
          d={agentHousePath}
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          className={twMerge(
            "animate-[camera-outline-trace_3s_linear_infinite] motion-reduce:animate-none motion-reduce:[stroke-dasharray:none] motion-reduce:opacity-65",
            !active && "[animation-play-state:paused]",
          )}
          d={agentHousePath}
          pathLength="100"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="18 82"
        />
      </svg>
    </span>
  );
}
