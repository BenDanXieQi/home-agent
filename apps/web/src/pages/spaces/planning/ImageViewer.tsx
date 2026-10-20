import { Dialog } from "radix-ui";
import { AnimatePresence, m } from "motion/react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { readPlanningImage } from "../../../modules/spatial/planning";

export type PlanningImage = Awaited<ReturnType<typeof readPlanningImage>> & {
  id: string;
};

const layoutKey = (id: string) => `planning-image-${id}`;

/**
 * A thumbnail that hands its layout over to the viewer while it is open, so
 * the image appears to grow out of the thumbnail and return to it on close.
 */
export function ImageThumbnail({
  image,
  open,
  label,
  onOpen,
  className = "",
}: {
  image: PlanningImage;
  open: boolean;
  label: string;
  onOpen: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className={`block overflow-hidden rounded-lg border border-line bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink ${className}`}
    >
      {open ? null : (
        <m.img
          layoutId={layoutKey(image.id)}
          src={image.preview}
          alt=""
          draggable={false}
          className="size-full object-cover"
        />
      )}
    </button>
  );
}

export function ImageViewer({
  images,
  current,
  onSelect,
  onClose,
}: {
  images: PlanningImage[];
  current: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const index = images.findIndex((image) => image.id === current);
  const image = images[index];
  const step = (offset: number) => {
    const next = images[(index + offset + images.length) % images.length];
    if (next) onSelect(next.id);
  };
  return (
    <Dialog.Root
      open={!!image}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AnimatePresence>
        {image ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <m.div
                className="fixed inset-0 z-40 bg-ink/80"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              />
            </Dialog.Overlay>
            <Dialog.Content
              asChild
              forceMount
              aria-describedby={undefined}
              onKeyDown={(event) => {
                if (images.length < 2) return;
                if (event.key === "ArrowLeft") step(-1);
                if (event.key === "ArrowRight") step(1);
              }}
            >
              <div className="fixed inset-0 z-50 outline-none">
                <m.div
                  className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 p-4 text-sm text-white"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <Dialog.Title className="min-w-0 truncate">
                    {image.name}
                    {images.length > 1 ? (
                      <span className="ml-2 text-white/60">
                        {index + 1} / {images.length}
                      </span>
                    ) : null}
                  </Dialog.Title>
                  <Dialog.Close
                    aria-label="关闭"
                    className="grid size-9 shrink-0 place-items-center rounded-full text-white hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  >
                    <X size={20} />
                  </Dialog.Close>
                </m.div>
                {/* Clicking around the image closes the viewer. */}
                <div
                  className="flex size-full items-center justify-center p-4"
                  onClick={(event) => {
                    if (event.target === event.currentTarget) onClose();
                  }}
                  aria-hidden="true"
                >
                  <m.img
                    key={image.id}
                    layoutId={layoutKey(image.id)}
                    src={image.preview}
                    alt={image.name}
                    draggable={false}
                    className={`max-h-[calc(100dvh-8.5rem)] rounded-xl bg-white object-contain ${images.length > 1 ? "max-w-[calc(100vw-8rem)]" : "max-w-[calc(100vw-2rem)]"}`}
                  />
                </div>
                {images.length > 1 ? (
                  <>
                    <button
                      type="button"
                      aria-label="上一张"
                      onClick={() => step(-1)}
                      className="fixed left-4 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-ink/60 text-white hover:bg-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                      <ChevronLeft size={22} />
                    </button>
                    <button
                      type="button"
                      aria-label="下一张"
                      onClick={() => step(1)}
                      className="fixed right-4 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-ink/60 text-white hover:bg-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                      <ChevronRight size={22} />
                    </button>
                  </>
                ) : null}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}
