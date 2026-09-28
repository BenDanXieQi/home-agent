import { GripVertical } from "lucide-react";
import { Separator } from "react-resizable-panels";

export function ResizeHandle({ label }: { label: string }) {
  return (
    <Separator
      aria-label={label}
      title={`${label}：左右拖动，或使用方向键`}
      className="group flex w-8 items-center justify-center outline-none select-none"
    >
      <span
        aria-hidden="true"
        className="flex h-10 w-6 items-center justify-center rounded-lg bg-surface text-muted transition-colors group-hover:bg-sidebar group-hover:text-ink group-focus-visible:outline-1 group-focus-visible:outline-accent/50 group-data-[separator=active]:bg-ink group-data-[separator=active]:text-white"
      >
        <GripVertical size={16} strokeWidth={1.75} />
      </span>
    </Separator>
  );
}
