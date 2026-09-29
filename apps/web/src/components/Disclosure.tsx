import { twMerge } from "tailwind-merge";
import { useState, type ComponentProps } from "react";
import { m, AnimatePresence } from "motion/react";
import { Collapsible } from "radix-ui";
import { ChevronDown } from "lucide-react";
import { spring } from "../utils/motion";

const MotionChevron = m.create(ChevronDown);

export function Disclosure({
  title,
  children,
  className = "",
  ...props
}: Omit<
  ComponentProps<typeof Collapsible.Root>,
  | "asChild"
  | "open"
  | "defaultOpen"
  | "onOpenChange"
  | "title"
  | "dangerouslySetInnerHTML"
> & {
  title: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root
      {...props}
      open={open}
      onOpenChange={setOpen}
      className={twMerge(`pt-2 ${className}`)}
    >
      <Collapsible.Trigger className="flex min-h-10 w-full items-center justify-between gap-3 text-left text-[13px] text-muted hover:text-ink">
        {title}
        <MotionChevron
          size={16}
          className="shrink-0"
          initial={false}
          animate={{ rotate: open ? 180 : 0 }}
        />
      </Collapsible.Trigger>
      <AnimatePresence initial={false}>
        {open ? (
          <Collapsible.Content forceMount asChild>
            {/* Height and content fade share one element but not one timeline. */}
            <m.div
              className="overflow-hidden text-sm leading-7 text-ink *:first:mt-4"
              initial={{ height: 0, opacity: 0 }}
              animate={{
                height: "auto",
                opacity: 1,
                transition: {
                  ...spring,
                  opacity: { duration: 0.22, delay: 0.04 },
                },
              }}
              exit={{
                height: 0,
                opacity: 0,
                transition: { ...spring, opacity: { duration: 0.16 } },
              }}
            >
              {children}
            </m.div>
          </Collapsible.Content>
        ) : null}
      </AnimatePresence>
    </Collapsible.Root>
  );
}
