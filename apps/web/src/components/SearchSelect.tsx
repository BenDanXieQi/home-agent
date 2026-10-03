import { useRef, useState } from "react";
import { Command } from "cmdk";
import { Popover } from "radix-ui";
import { AnimatePresence, m } from "motion/react";
import { Check, ChevronDown, Search } from "lucide-react";
import { twMerge } from "tailwind-merge";
import type { SelectProps } from "./Select";

export function SearchSelect<Value extends string>({
  value,
  onValueChange,
  options,
  label,
  placeholder = "请选择",
  disabled,
  className,
  onKeyDown,
  ...props
}: SelectProps<Value>) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.value === value);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <m.button
          {...props}
          type="button"
          disabled={disabled}
          aria-label={`${label}：${selected?.label ?? placeholder}`}
          className={twMerge(
            "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-transparent bg-surface px-3 text-left text-[13px] text-ink transition-colors enabled:hover:bg-sidebar data-[state=open]:bg-sidebar",
            className,
          )}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (
              !event.defaultPrevented &&
              (event.key === "ArrowDown" || event.key === "ArrowUp")
            ) {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <span className="truncate" title={selected?.label}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronDown size={14} className="shrink-0 text-muted" />
        </m.button>
      </Popover.Trigger>
      <AnimatePresence>
        {open ? (
          <Popover.Portal forceMount>
            <Popover.Content
              forceMount
              asChild
              align="start"
              sideOffset={6}
              collisionPadding={12}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                input.current?.focus();
              }}
            >
              <m.div
                className="z-60 w-(--radix-popover-trigger-width) min-w-44 origin-(--radix-popover-content-transform-origin) rounded-xl bg-white p-1.5 shadow-panel outline-none"
                initial={{ opacity: 0, scale: 0.96, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{
                  opacity: 0,
                  scale: 0.97,
                  y: -4,
                  transition: { duration: 0.16 },
                }}
              >
                <Command
                  label={label}
                  defaultValue={JSON.stringify(value)}
                  loop
                >
                  <div className="m-1 flex items-center gap-2 rounded-md bg-surface px-2 text-muted focus-within:outline-1 focus-within:outline-accent/50">
                    <Search size={13} aria-hidden="true" />
                    <Command.Input
                      ref={input}
                      aria-label={`搜索${label}`}
                      placeholder="搜索…"
                      className="h-7 border-0 bg-transparent p-0 text-xs outline-none focus-visible:outline-none"
                    />
                  </div>
                  <Command.List className="max-h-[min(270px,var(--radix-popover-content-available-height))] overflow-y-auto overscroll-contain">
                    <Command.Empty className="px-2.5 py-4 text-xs text-muted">
                      没有匹配项
                    </Command.Empty>
                    {options.map((option) => (
                      <Command.Item
                        key={option.value}
                        value={JSON.stringify(option.value)}
                        keywords={[option.label]}
                        className="flex min-h-9 cursor-pointer select-none items-center justify-between gap-2 rounded-xl px-2.5 text-xs text-ink data-[selected=true]:bg-ink data-[selected=true]:text-white"
                        onSelect={() => {
                          if (option.value !== value)
                            onValueChange(option.value);
                          setOpen(false);
                        }}
                      >
                        <span className="truncate" title={option.label}>
                          {option.label}
                        </span>
                        {option.value === value ? (
                          <Check size={13} className="shrink-0" />
                        ) : null}
                      </Command.Item>
                    ))}
                  </Command.List>
                </Command>
              </m.div>
            </Popover.Content>
          </Popover.Portal>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}
