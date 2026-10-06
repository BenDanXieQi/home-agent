import {
  AnimatePresence,
  easeOut,
  m,
  useIsPresent,
  useReducedMotion,
  useTransform,
  type useScroll,
} from "motion/react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Button } from "../../components/Button";

/** Scroll proximity owns the button fade; presence owns only the outer flight. */
export function ReturnLatest({
  returning,
  count,
  scrollY,
  onReturn,
  label,
}: {
  returning: boolean;
  count: number;
  scrollY: ReturnType<typeof useScroll>["scrollY"];
  onReturn: () => void;
  label: string;
}) {
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();
  const opacity = useTransform(scrollY, [0, 64], [0.08, 1], { ease: easeOut });
  return (
    <m.div
      inert={!present}
      className="absolute inset-x-0 top-2 z-10 flex justify-center pointer-events-none"
      initial={
        reducedMotion ? false : { opacity: 0, transform: "translateY(-8px)" }
      }
      animate={{
        opacity: 1,
        transform: "translateY(0px)",
      }}
      exit={{
        opacity: 0,
        transform: reducedMotion ? "none" : "translateY(-18px)",
        transition: {
          duration: reducedMotion ? 0 : 0.09,
          ease: "easeOut",
        },
      }}
      transition={{
        duration: reducedMotion ? 0 : 0.2,
        ease: "easeOut",
      }}
    >
      <Button
        className="[&_.agent-avatar]:w-8 [&_.agent-avatar]:h-8 pointer-events-auto shrink-0 whitespace-nowrap tabular-nums shadow-panel"
        variant="primary"
        style={{ opacity: reducedMotion ? 1 : opacity }}
        aria-label={count ? `${label}，${count} 条新记录` : label}
        icon={
          <span
            className="relative inline-flex w-8 h-7 items-center motion-safe:[&[data-returning='true']_.agent-avatar-gaze]:[transform:translateY(-2px)]"
            data-returning={returning}
            aria-hidden="true"
          >
            <m.span
              className="inline-flex"
              initial={false}
              animate={{
                transform:
                  returning && !reducedMotion
                    ? "translateY(-3px)"
                    : "translateY(0px)",
              }}
              transition={{
                duration: reducedMotion ? 0 : 0.12,
                ease: "easeOut",
              }}
            >
              <AgentAvatar
                state={returning ? "idle" : count ? "attention" : "idle"}
              />
            </m.span>
            {returning &&
              !reducedMotion &&
              [0, 1, 2].map((index) => (
                <m.span
                  key={index}
                  className="absolute top-5.25 w-0.5 h-1.25 rounded-xs bg-current"
                  style={{ left: 10 + index * 5 }}
                  initial={{
                    opacity: 0,
                    transform: "translateY(0px) scaleY(1)",
                  }}
                  animate={{
                    opacity: 0.85,
                    transform: [
                      "translateY(0px) scaleY(1)",
                      "translateY(3px) scaleY(0.65)",
                      "translateY(0px) scaleY(1)",
                    ],
                  }}
                  transition={{
                    opacity: {
                      delay: 0.12,
                      duration: 0.18,
                      ease: "easeOut",
                    },
                    transform: {
                      delay: 0.12,
                      duration: 0.28 + index * 0.04,
                      repeat: Infinity,
                      ease: "linear",
                    },
                  }}
                />
              ))}
          </span>
        }
        disabled={returning}
        aria-busy={returning}
        onClick={onReturn}
      >
        <span className="relative inline-flex items-center">
          {label}
          <AnimatePresence initial={false} mode="popLayout">
            {count > 0 && (
              <m.span
                key="count"
                className="inline-flex items-center justify-center flex-none w-[calc(3ch_+_12px)] h-5.5 ml-2 rounded-full bg-[rgb(255_255_255_/_16%)] text-[12px] tabular-nums"
                aria-hidden="true"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.18 }}
              >
                {count}
              </m.span>
            )}
          </AnimatePresence>
        </span>
      </Button>
    </m.div>
  );
}
