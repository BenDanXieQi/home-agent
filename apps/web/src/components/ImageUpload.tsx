import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { listenForImageDrop, imageUploadTypes } from "../modules/media/images";

export function ImageFileInput({
  ref,
  disabled,
  label,
  onFiles,
}: {
  ref: RefObject<HTMLInputElement | null>;
  disabled: boolean;
  label: string;
  onFiles: (files: File[]) => void;
}) {
  return (
    <input
      ref={ref}
      type="file"
      multiple
      accept={imageUploadTypes.join(",")}
      disabled={disabled}
      tabIndex={-1}
      aria-label={label}
      className="hidden"
      onChange={(event) => {
        const files = [...(event.target.files ?? [])];
        event.target.value = "";
        if (files.length) onFiles(files);
      }}
    />
  );
}

export function ImageDropZone({
  children,
  className,
  label,
  dropLabel,
  disabled,
  onFiles,
}: {
  children: ReactNode;
  className: string;
  label: string;
  dropLabel: string;
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);
  const receive = useEffectEvent((files: File[]) => {
    if (!disabled) onFiles(files);
  });

  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    return listenForImageDrop(element, receive, setDragging);
  }, []);

  return (
    <section ref={root} className={`relative ${className}`} aria-label={label}>
      {children}
      {dragging && !disabled ? (
        <div
          className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-ink bg-paper/85 text-sm font-medium"
          aria-hidden="true"
        >
          {dropLabel}
        </div>
      ) : null}
    </section>
  );
}
