import { twMerge } from "tailwind-merge";
import { animate, m, useMotionValue, useReducedMotion } from "motion/react";
import { useLayoutEffect, type ComponentProps } from "react";
import { agentHousePath } from "./agent-mark";

const settle = { type: "spring", duration: 0.48, bounce: 0 } as const;
const ponderRotation = [0, -4, 0, 4, 0];
const ponderLift = [0, -1, 0, -1, 0];
const greetRotation = [0, -7, 4, 0];
const greetLift = [0, -2, -1, 0];
const lookX = [0, -2, 2, 0];
const lookY = [0, -1, -1, 0];
const blink = [1, 1, 0.15, 1, 1];
const blinkTimes = [0, 0.43, 0.45, 0.47, 1];
const talk = [1, 1.7, 0.75, 1];

/** Numeric values own their initial pose; no DOM transform parsing is needed. */
function useAvatarMotion(
  pose: number,
  reduced: boolean | null,
  keyframes?: number[],
  {
    duration = 1,
    repeat = Infinity,
    times,
  }: {
    duration?: number;
    repeat?: number;
    times?: number[] | undefined;
  } = {},
) {
  const value = useMotionValue(pose);
  useLayoutEffect(() => {
    let cancelled = false;
    let cycle: ReturnType<typeof animate> | undefined;
    const startCycle = () => {
      if (cancelled || reduced || !keyframes) return;
      cycle = animate(value, keyframes, {
        type: "tween",
        duration,
        ease: "easeInOut",
        repeat,
        ...(times ? { times } : {}),
      });
    };
    // Mount (including StrictMode replay) starts at the actual pose immediately.
    const arrival =
      !reduced && value.get() !== pose
        ? animate(value, pose, settle)
        : undefined;
    if (arrival) void arrival.then(startCycle);
    else {
      value.set(pose);
      startCycle();
    }
    return () => {
      cancelled = true;
      arrival?.stop();
      cycle?.stop();
    };
  }, [value, pose, keyframes, duration, repeat, times, reduced]);
  return value;
}

/** Decorative identity; the containing control or message provides its accessible name. */
export function AgentAvatar({
  state = "idle",
  className = "",
  ...props
}: Omit<ComponentProps<"span">, "children" | "dangerouslySetInnerHTML"> & {
  state?:
    | "idle"
    | "thinking"
    | "speaking"
    | "listening"
    | "attention"
    | "offline";
}) {
  const reduced = useReducedMotion();
  const thinking = state === "thinking";
  const attention = state === "attention";
  const speaking = state === "speaking";
  const offline = state === "offline";
  const blinking = state === "idle" || state === "listening";
  const headCycle = {
    duration: attention ? 0.85 : 4.8,
    repeat: attention ? 0 : Infinity,
  };
  const rotate = useAvatarMotion(
    state === "listening" ? -4 : 0,
    reduced,
    thinking ? ponderRotation : attention ? greetRotation : undefined,
    headCycle,
  );
  const y = useAvatarMotion(
    0,
    reduced,
    thinking ? ponderLift : attention ? greetLift : undefined,
    headCycle,
  );
  const gazeX = useAvatarMotion(0, reduced, thinking ? lookX : undefined, {
    duration: 2.4,
  });
  const gazeY = useAvatarMotion(0, reduced, thinking ? lookY : undefined, {
    duration: 2.4,
  });
  const houseY = useAvatarMotion(offline ? 1 : 0, reduced);
  const houseScaleX = useAvatarMotion(speaking ? 1.04 : 1, reduced);
  const houseScaleY = useAvatarMotion(speaking ? 0.96 : 1, reduced);
  const eyesY = useAvatarMotion(offline ? 1 : 0, reduced);
  const eyesScaleX = useAvatarMotion(offline ? 1.2 : 1, reduced);
  const eyesScaleY = useAvatarMotion(
    offline ? 0.35 : thinking ? 0.8 : attention ? 1.35 : 1,
    reduced,
    blinking ? blink : speaking ? talk : undefined,
    {
      duration: state === "idle" ? 8 : state === "listening" ? 5.6 : 0.72,
      times: blinking ? blinkTimes : undefined,
    },
  );

  return (
    <span
      {...props}
      className={twMerge(
        `agent-avatar inline-flex flex-none w-[var(--agent-avatar-size,_36px)] h-[var(--agent-avatar-size,_36px)] overflow-visible text-inherit ${className}`,
      )}
      data-state={state}
      aria-hidden="true"
    >
      <m.svg
        className="block w-full h-full origin-[50%_65%] [transition:rotate_320ms_ease,_translate_320ms_ease] motion-reduce:transition-none motion-reduce:[translate:none] motion-reduce:[rotate:none]"
        initial={false}
        inherit={false}
        style={{ rotate, y }}
        viewBox="0 0 64 64"
        fill="none"
        focusable="false"
      >
        <m.path
          initial={false}
          inherit={false}
          style={{ y: houseY, scaleX: houseScaleX, scaleY: houseScaleY }}
          className="[transform-box:fill-box] origin-center"
          d={agentHousePath}
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <m.g
          initial={false}
          inherit={false}
          style={{ x: gazeX, y: gazeY }}
          className="agent-avatar-gaze [transform-box:fill-box] origin-center"
        >
          <m.g
            initial={false}
            inherit={false}
            style={{ y: eyesY, scaleX: eyesScaleX, scaleY: eyesScaleY }}
            className="[transform-box:fill-box] origin-center"
          >
            <circle cx="27" cy="35" r="2.5" fill="currentColor" />
            <circle cx="37" cy="35" r="2.5" fill="currentColor" />
          </m.g>
        </m.g>
      </m.svg>
    </span>
  );
}
