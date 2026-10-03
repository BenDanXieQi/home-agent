import { twMerge } from "tailwind-merge";
import { type ComponentProps, useState } from "react";
import { m } from "motion/react";
import { Select as SelectPrimitive } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";

const MotionChevron = m.create(ChevronDown);

export type SelectProps<Value extends string> = Omit<
  ComponentProps<typeof m.button>,
  "value" | "defaultValue" | "onChange" | "children" | "dangerouslySetInnerHTML"
> & {
  value: Value;
  onValueChange: (value: Value) => void;
  options: readonly { value: Value; label: string }[];
  label: string;
  placeholder?: string;
};

export function Select<Value extends string>({
  value,
  onValueChange,
  options,
  label,
  placeholder = "请选择",
  disabled = false,
  className,
  ...props
}: SelectProps<Value>) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <SelectPrimitive.Root
      open={open}
      onOpenChange={setOpen}
      value={JSON.stringify(value)}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find(
          (item) => JSON.stringify(item.value) === next,
        );
        if (option && option.value !== value) onValueChange(option.value);
      }}
    >
      <SelectPrimitive.Trigger asChild>
        <m.button
          {...props}
          type="button"
          aria-label={`${label}：${selected?.label ?? placeholder}`}
          className={twMerge(
            "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-transparent bg-surface px-3 text-left text-[13px] text-ink transition-colors enabled:hover:bg-sidebar data-[state=open]:bg-sidebar",
            className,
          )}
        >
          <SelectPrimitive.Value placeholder={placeholder}>
            <span className="truncate" title={selected?.label}>
              {selected?.label ?? placeholder}
            </span>
          </SelectPrimitive.Value>
          <SelectPrimitive.Icon asChild>
            <MotionChevron
              size={14}
              className="shrink-0 text-muted"
              initial={false}
              animate={{ rotate: open ? 180 : 0 }}
            />
          </SelectPrimitive.Icon>
        </m.button>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          asChild
          position="popper"
          align="start"
          sideOffset={6}
          collisionPadding={12}
        >
          <m.div
            className="z-60 max-h-[min(320px,var(--radix-select-content-available-height))] w-(--radix-select-trigger-width) min-w-44 origin-(--radix-select-content-transform-origin) overflow-hidden rounded-xl bg-white p-1.5 shadow-panel outline-none"
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
          >
            <SelectPrimitive.Viewport className="overscroll-contain">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={JSON.stringify(option.value)}
                  textValue={option.label}
                  className="flex min-h-9 cursor-pointer select-none items-center justify-between gap-2 rounded-xl px-2.5 text-xs text-ink outline-none data-[highlighted]:bg-ink data-[highlighted]:text-white data-[state=checked]:font-medium"
                >
                  <SelectPrimitive.ItemText>
                    <span className="truncate" title={option.label}>
                      {option.label}
                    </span>
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator>
                    <Check size={13} />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
              {!options.length ? (
                <p className="px-2.5 py-4 text-xs text-muted">没有匹配项</p>
              ) : null}
            </SelectPrimitive.Viewport>
          </m.div>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
