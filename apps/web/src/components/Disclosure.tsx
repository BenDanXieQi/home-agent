import { useState, type ReactNode } from "react";
import { m, AnimatePresence } from "motion/react";
import { Collapsible } from "radix-ui";
import { ChevronDown } from "lucide-react";

export function Disclosure({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="border-t border-line pt-4"
    >
      <Collapsible.Trigger className="group flex w-full items-center justify-between text-xs text-muted">
        {title}
        <ChevronDown size={16} className="group-data-[state=open]:rotate-180" />
      </Collapsible.Trigger>
      <AnimatePresence initial={false}>
        {open ? (
          <Collapsible.Content forceMount asChild>
            <m.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="pt-4 text-xs leading-7 text-muted"
            >
              {children}
            </m.div>
          </Collapsible.Content>
        ) : null}
      </AnimatePresence>
    </Collapsible.Root>
  );
}
