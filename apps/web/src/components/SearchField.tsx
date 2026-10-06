import type { ComponentProps } from "react";
import { Search, X } from "lucide-react";
import { twMerge } from "tailwind-merge";

export function SearchField({
  label,
  placeholder,
  value,
  onChange,
  className,
  inputProps,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  inputProps?: Pick<ComponentProps<"input">, "ref" | "maxLength">;
}) {
  return (
    <label
      className={twMerge("relative m-0 flex min-w-0 items-center", className)}
    >
      <Search
        size={14}
        className="pointer-events-none absolute left-3 text-muted"
        aria-hidden="true"
      />
      <input
        {...inputProps}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 pl-9 pr-9 text-[13px] [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value ? (
        <button
          type="button"
          aria-label={`清除${label}`}
          className="absolute right-2 rounded p-1 text-muted hover:text-ink focus-visible:outline-2"
          onClick={() => onChange("")}
        >
          <X size={14} />
        </button>
      ) : null}
    </label>
  );
}
