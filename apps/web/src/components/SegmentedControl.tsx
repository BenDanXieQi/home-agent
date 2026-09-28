import { twMerge } from "tailwind-merge";
import { SelectionIndicator } from "./SelectionIndicator";
import { useId, type ComponentProps } from "react";
import { ToggleGroup } from "radix-ui";
import { m } from "motion/react";

const variants = {
  pill: {
    root: "gap-1 p-1",
    item: "rounded-full px-4 py-2 data-[state=on]:font-medium data-[state=on]:text-white",
    indicator: "inset-0 rounded-full",
  },
  underline: {
    root: "gap-4",
    item: "py-2.5 data-[state=on]:font-semibold data-[state=on]:text-[var(--segmented-accent,var(--color-accent))]",
    indicator:
      "inset-x-0 bottom-0 h-0.5 rounded-full bg-[var(--segmented-accent,var(--color-accent))]",
  },
};

/**
 * Single-choice switcher with a shared layout indicator. Arrow keys move focus and
 * select at once, so keyboard and pointer drive the same indicator motion.
 * An ancestor's `--segmented-accent` recolors the underline variant.
 */
export function SegmentedControl<Value extends string>({
  value,
  onValueChange,
  options,
  label,
  variant = "pill",
  className = "",
  ref,
  ...props
}: Omit<
  Extract<ComponentProps<typeof ToggleGroup.Root>, { type: "single" }>,
  | "type"
  | "value"
  | "defaultValue"
  | "onValueChange"
  | "children"
  | "asChild"
  | "dangerouslySetInnerHTML"
> & {
  value: Value;
  onValueChange: (value: Value) => void;
  options: readonly { value: Value; label: string }[];
  label: string;
  variant?: keyof typeof variants;
}) {
  const selectionId = useId();
  const styles = variants[variant];
  const select = (next: string) => {
    const option = options.find((item) => item.value === next);
    if (option && option.value !== value) onValueChange(option.value);
  };
  return (
    <ToggleGroup.Root
      asChild
      {...props}
      ref={ref}
      type="single"
      value={value}
      onValueChange={select}
      aria-label={label}
      className={twMerge(
        `relative isolate flex max-w-full items-center overflow-x-auto ${styles.root} ${className}`,
      )}
    >
      <m.div layoutScroll>
        {options.map((option) => (
          <ToggleGroup.Item
            key={option.value}
            value={option.value}
            className={twMerge(
              `relative isolate shrink-0 whitespace-nowrap text-xs text-muted transition-colors enabled:hover:text-ink data-[state=on]:pointer-events-none ${styles.item}`,
            )}
            onFocus={() => select(option.value)}
          >
            {option.value === value ? (
              <SelectionIndicator
                layoutId={selectionId}
                className={styles.indicator}
              />
            ) : null}
            {option.label}
          </ToggleGroup.Item>
        ))}
      </m.div>
    </ToggleGroup.Root>
  );
}
