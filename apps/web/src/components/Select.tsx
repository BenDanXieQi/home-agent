import { twMerge } from "tailwind-merge";
import { SelectionIndicator } from "./SelectionIndicator";
import {
  type ComponentProps,
  useCallback,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AnimatePresence, m } from "motion/react";
import { Popover } from "radix-ui";
import { Check, ChevronDown, Search } from "lucide-react";

const MotionChevron = m.create(ChevronDown);

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- A styled listbox in a popover replaces the native select. */
/**
 * Replaces the native select: the menu matches the trigger's width, grows out
 * of it (flipping above when there is no room), and a highlight slides to the
 * active option for pointer and keyboard alike. Type to jump, or pass
 * `searchable` for a filter field.
 */
export function Select<Value extends string>({
  value,
  onValueChange,
  options,
  label,
  placeholder = "请选择",
  searchable = false,
  disabled = false,
  className = "",
  onKeyDown: onTriggerKeyDown,
  ...props
}: Omit<
  ComponentProps<typeof m.button>,
  "value" | "defaultValue" | "onChange" | "children" | "dangerouslySetInnerHTML"
> & {
  value: Value;
  onValueChange: (value: Value) => void;
  options: readonly { value: Value; label: string }[];
  label: string;
  placeholder?: string;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const attachList = useCallback((element: HTMLDivElement | null) => {
    list.current = element;
    element
      ?.querySelector("[data-active]")
      ?.scrollIntoView({ block: "nearest" });
  }, []);
  const typed = useRef({ text: "", at: 0 });
  const matches = options.filter((option) =>
    option.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const index = Math.min(active, Math.max(0, matches.length - 1));
  const selected = options.find((option) => option.value === value);

  function choose(next: Value) {
    if (next !== value) onValueChange(next);
    setOpen(false);
  }
  function move(next: number) {
    const bounded = Math.max(0, Math.min(matches.length - 1, next));
    setActive(bounded);
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${bounded}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }
  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (searchable && (event.key === "Home" || event.key === "End")) return;
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(index + 1),
      ArrowUp: () => move(index - 1),
      Home: () => move(0),
      End: () => move(matches.length - 1),
      Enter: () => {
        const option = matches[index];
        if (option) choose(option.value);
      },
      ...(!searchable
        ? {
            " ": () => {
              const option = matches[index];
              if (option) choose(option.value);
            },
          }
        : {}),
    };
    const handle = keys[event.key];
    if (handle) {
      event.preventDefault();
      handle();
      return;
    }
    // Typeahead: consecutive letters within a second narrow to an option.
    if (!searchable && event.key.length === 1 && !event.metaKey) {
      const now = Date.now();
      typed.current = {
        text:
          (now - typed.current.at < 1000 ? typed.current.text : "") +
          event.key.toLowerCase(),
        at: now,
      };
      const found = matches.findIndex((option) =>
        option.label.toLowerCase().startsWith(typed.current.text),
      );
      if (found >= 0) move(found);
    }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          typed.current = { text: "", at: 0 };
          setQuery("");
          setActive(
            Math.max(
              0,
              options.findIndex((option) => option.value === value),
            ),
          );
        }
      }}
    >
      <Popover.Trigger asChild>
        <m.button
          {...props}
          initial={false}
          animate={{ borderRadius: open ? 10 : 8 }}
          type="button"
          aria-label={`${label}：${selected?.label ?? placeholder}`}
          aria-haspopup="listbox"
          onKeyDown={(event) => {
            onTriggerKeyDown?.(event);
            if (event.defaultPrevented) return;
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            setQuery("");
            typed.current = { text: "", at: 0 };
            const selectedIndex = options.findIndex(
              (option) => option.value === value,
            );
            setActive(
              selectedIndex >= 0
                ? selectedIndex
                : event.key === "ArrowUp"
                  ? Math.max(0, options.length - 1)
                  : 0,
            );
            setOpen(true);
          }}
          disabled={disabled}
          className={twMerge(
            `flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-transparent bg-surface px-3 text-left text-[13px] text-ink transition-colors enabled:hover:bg-sidebar data-[state=open]:bg-sidebar ${className}`,
          )}
        >
          <span className="truncate" title={selected?.label ?? placeholder}>
            {selected?.label ?? placeholder}
          </span>
          <MotionChevron
            size={14}
            className="shrink-0 text-muted"
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
          />
        </m.button>
      </Popover.Trigger>
      <AnimatePresence>
        {open ? (
          <Popover.Portal forceMount>
            <Popover.Content
              forceMount
              asChild
              side="bottom"
              align="start"
              sideOffset={6}
              collisionPadding={12}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                list.current
                  ?.closest<HTMLElement>("[data-select-content]")
                  ?.querySelector<HTMLElement>("input, [role=listbox]")
                  ?.focus();
              }}
            >
              {/* Grows out of the trigger and folds back into it. */}
              <m.div
                data-select-content
                className="z-60 flex max-h-[min(320px,var(--radix-popover-content-available-height))] w-(--radix-popover-trigger-width) min-w-44 origin-(--radix-popover-content-transform-origin) flex-col rounded-xl bg-white p-1.5 shadow-panel outline-none"
                initial={{ opacity: 0, scale: 0.96, y: -4, borderRadius: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0, borderRadius: 12 }}
                exit={{
                  opacity: 0,
                  scale: 0.97,
                  y: -4,
                  transition: { duration: 0.16 },
                }}
              >
                {searchable ? (
                  <label className="m-1 flex shrink-0 items-center gap-2 rounded-md bg-surface px-2 text-muted focus-within:outline-1 focus-within:outline-offset-0 focus-within:outline-accent/50">
                    <Search size={13} className="shrink-0" aria-hidden="true" />
                    <input
                      className="h-7 border-0 bg-transparent p-0 text-xs outline-none focus-visible:outline-none"
                      value={query}
                      placeholder="搜索…"
                      aria-label={`搜索${label}`}
                      role="combobox"
                      aria-expanded={open}
                      aria-autocomplete="list"
                      aria-controls={id}
                      aria-activedescendant={
                        matches.length ? `${id}-${index}` : undefined
                      }
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setActive(0);
                      }}
                      onKeyDown={onKeyDown}
                    />
                  </label>
                ) : null}
                <m.div
                  layoutScroll
                  ref={attachList}
                  id={id}
                  role="listbox"
                  aria-label={label}
                  tabIndex={searchable ? -1 : 0}
                  aria-activedescendant={
                    matches.length ? `${id}-${index}` : undefined
                  }
                  className="relative isolate min-h-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] outline-none"
                  onKeyDown={onKeyDown}
                >
                  {matches.map((option, offset) => (
                    <button
                      type="button"
                      tabIndex={-1}
                      key={option.value}
                      id={`${id}-${offset}`}
                      role="option"
                      aria-selected={option.value === value}
                      data-index={offset}
                      data-active={offset === index || undefined}
                      className="relative isolate flex min-h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 text-xs text-ink select-none data-active:text-white aria-selected:font-medium"
                      onPointerMove={() => setActive(offset)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(option.value)}
                    >
                      {offset === index ? (
                        <SelectionIndicator
                          layoutId={`${id}-highlight`}
                          className="inset-0 rounded-xl"
                        />
                      ) : null}
                      <span className="truncate" title={option.label}>
                        {option.label}
                      </span>
                      {option.value === value ? (
                        <Check size={13} className="shrink-0" />
                      ) : null}
                    </button>
                  ))}
                  {!matches.length ? (
                    <p className="px-2.5 py-4 text-xs text-muted">没有匹配项</p>
                  ) : null}
                </m.div>
              </m.div>
            </Popover.Content>
          </Popover.Portal>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}
/* oxlint-enable jsx-a11y/prefer-tag-over-role */
