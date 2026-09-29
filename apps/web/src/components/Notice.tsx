import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";
const layout =
  "[form_>_&]:mt-4 [form_>_div_>_&]:mt-4 mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl px-5 py-4 text-sm leading-6 [&_strong]:block [&_strong]:w-full [&_strong]:font-medium [&_ul]:w-full";

const noticeStyles = {
  neutral: `${layout} bg-surface`,
  warning: `${layout} bg-warning/7 text-warning`,
  error: `${layout} bg-danger/5 text-danger`,
};

export function Notice({
  tone = "neutral",
  className,
  role,
  ...props
}: ComponentProps<"div"> & { tone?: keyof typeof noticeStyles }) {
  return (
    <div
      {...props}
      role={role ?? (tone === "error" ? "alert" : undefined)}
      className={twMerge(noticeStyles[tone], className)}
    />
  );
}

export function StatusNotice({
  tone = "neutral",
  className,
  ...props
}: ComponentProps<"output"> & { tone?: keyof typeof noticeStyles }) {
  return (
    <output {...props} className={twMerge(noticeStyles[tone], className)} />
  );
}
