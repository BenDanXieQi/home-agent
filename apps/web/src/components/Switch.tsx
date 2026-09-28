import { twMerge } from "tailwind-merge";
import { useState, useRef, type ComponentProps, type ReactNode } from "react";
import { m, useReducedMotion } from "motion/react";
import { Switch as RadixSwitch } from "radix-ui";

// Track geometry in px; mirrored by the track and knob utility classes below.
const inset = 2;
const knob = 16;
const travel = 12;
const pressedKnob = 20;
const offset = (on: boolean) => inset + (on ? travel : 0);

/**
 * Toggle whose knob widens while pressed and tracks the pointer while dragged.
 * After release, the checked prop owns both the track and knob destination.
 * Remaining props go to the motion label, so presence and layout need no wrapper.
 */
export function Switch({
  checked,
  onCheckedChange,
  children,
  className = "",
  ...props
}: Omit<ComponentProps<typeof m.label>, "children"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const [pressing, setPressing] = useState(false);
  const [position, setPosition] = useState<number | null>(null);
  const dragged = useRef(false);
  const resting = offset(checked);
  const pressed = checked ? resting + knob - pressedKnob : resting;

  const origin = useRef(pressed);
  const dragPosition = (delta: number) =>
    Math.min(
      offset(true) + knob - pressedKnob,
      Math.max(inset, origin.current + delta),
    );

  return (
    <m.label
      className={twMerge(
        `m-0 inline-flex min-h-6 cursor-pointer items-center gap-1.5 text-[11px] select-none ${className}`,
      )}
      {...props}
      onPointerDownCapture={(event) => {
        dragged.current = false;
        props.onPointerDownCapture?.(event);
      }}
      onKeyDownCapture={(event) => {
        if (event.key === " " || event.key === "Enter") dragged.current = false;
        props.onKeyDownCapture?.(event);
      }}
      onClickCapture={(event) => {
        // Release outside the track can click the label, which forwards a
        // detail=0 click to the button. Suppress the whole drag's activation.
        if (dragged.current) {
          event.preventDefault();
          event.stopPropagation();
        }
        props.onClickCapture?.(event);
      }}
    >
      <RadixSwitch.Root
        className="relative h-5 w-8 shrink-0 touch-none overflow-hidden rounded-full bg-[#c7c7c7] transition-colors data-[state=checked]:bg-ink"
        checked={checked}
        onCheckedChange={onCheckedChange}
        asChild
      >
        <m.button
          onTapStart={() => setPressing(true)}
          onTap={() => setPressing(false)}
          onTapCancel={() => setPressing(false)}
          onPanSessionStart={() => {
            origin.current = pressed;
          }}
          onPanStart={() => {
            dragged.current = true;
          }}
          onPan={(_, info) => setPosition(dragPosition(info.offset.x))}
          onPanEnd={(event, info) => {
            setPressing(false);
            setPosition(null);
            if (event.type === "pointercancel") return;
            const middle = inset + (travel + knob - pressedKnob) / 2;
            const next = dragPosition(info.offset.x) > middle;
            if (next !== checked) onCheckedChange(next);
          }}
        >
          <RadixSwitch.Thumb asChild>
            <m.span
              className="absolute top-0.5 left-0 block h-4 rounded-full bg-white shadow-[0_1px_2px_#0002]"
              initial={false}
              animate={{
                x: position ?? (pressing && !reduced ? pressed : resting),
                width: pressing && !reduced ? pressedKnob : knob,
              }}
              transition={{
                type: "tween",
                duration: reduced || position !== null ? 0 : 0.16,
                ease: "easeOut",
              }}
            />
          </RadixSwitch.Thumb>
        </m.button>
      </RadixSwitch.Root>
      {children}
    </m.label>
  );
}
