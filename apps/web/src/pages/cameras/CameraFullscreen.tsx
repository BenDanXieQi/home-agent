import { Maximize, Minimize } from "lucide-react";
import { Button } from "../../components/Button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { animate } from "motion/mini";

/** Keep the player mounted while its surface moves into the browser's top layer. */
export function CameraFullscreen({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const animation = useRef<ReturnType<typeof animate> | null>(null);
  const restore = useRef<(() => void) | null>(null);
  const targetExpanded = useRef(false);
  const [phase, setPhase] = useState<"inline" | "expanded" | "closing">(
    "inline",
  );
  const expanded = phase === "expanded";
  const modal = phase !== "inline";
  const reduced = useReducedMotion();

  useEffect(
    () => () => {
      animation.current?.cancel();
      animation.current = null;
      restore.current?.();
    },
    [],
  );

  useEffect(() => {
    if (!modal) return undefined;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [modal]);

  async function toggle() {
    const surface = dialog.current;
    const origin = slot.current;
    if (!surface || !origin) return;
    const bounds = origin.getBoundingClientRect();
    const opening = !targetExpanded.current;
    targetExpanded.current = opening;
    // Stopping commits the current visual position, so reversing mid-flight
    // continues from that position instead of restarting at an endpoint.
    animation.current?.stop();
    const transition = {
      duration: reduced ? 0 : 0.3,
      ease: [0.22, 1, 0.36, 1] as const,
    };
    if (!opening) {
      setPhase("closing");

      // Await the whole group: per-property completion callbacks can run
      // before the other property has committed its final inline style.
      const exit = animate(
        surface,
        {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
          borderRadius: "16px",
        },
        transition,
      );
      animation.current = exit;
      await exit.finished;
      if (animation.current !== exit) return;
      exit.cancel();
      animation.current = null;
      surface.close();
      for (const property of [
        "left",
        "top",
        "width",
        "height",
        "border-radius",
      ]) {
        surface.style.removeProperty(property);
      }
      origin.style.height = "";
      restore.current?.();
      restore.current = null;
      setPhase("inline");
    } else {
      const wasOpen = surface.open;
      if (!wasOpen) {
        const focused = document.activeElement;
        origin.style.height = `${bounds.height}px`;
        restore.current = () => {
          if (focused instanceof HTMLElement && focused.isConnected)
            focused.focus({ preventScroll: true });
        };
        // showModal synchronously applies the top-layer layout. Pin its first
        // visible frame before that switch; animate() resolves keyframes later.
        Object.assign(surface.style, {
          left: `${bounds.left}px`,
          top: `${bounds.top}px`,
          width: `${bounds.width}px`,
          height: `${bounds.height}px`,
          borderRadius: "16px",
        });
        surface.showModal();
      }
      setPhase("expanded");
      // Animate the actual box, not a scaled fullscreen layout. At the end of
      // closing, the header, video and footer already match their inline sizes.
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;
      animation.current = animate(
        surface,
        {
          left: 0,
          top: 0,
          width: viewportWidth,
          height: viewportHeight,
          borderRadius: "0px",
        },
        transition,
      );
    }
  }

  return (
    <div ref={slot}>
      <dialog
        ref={dialog}
        aria-label={`${name}${modal ? " 全屏画面" : " 视频预览"}`}
        onCancel={async (event) => {
          event.preventDefault();
          if (targetExpanded.current) await toggle();
        }}
        className="relative m-0 flex w-full max-w-none flex-col border-0 bg-white p-0 text-ink open:fixed open:left-0 open:top-0 open:h-dvh open:max-h-none open:w-screen open:overflow-hidden backdrop:bg-transparent open:[&_.camera-surface]:min-h-0 open:[&_.camera-surface]:flex-1 open:[&_.camera-surface]:aspect-auto open:[&_video]:object-contain"
      >
        <Button
          size="small"
          type="button"
          variant="ghost"
          className="absolute right-1.5 top-5 z-10 outline-none focus-visible:outline-none focus-visible:bg-surface enabled:hover:bg-surface"
          aria-label={`${expanded ? "退出全屏" : "全屏查看"}${name}`}
          title={expanded ? "退出全屏（Esc）" : "全屏查看"}
          icon={expanded ? <Minimize size={15} /> : <Maximize size={15} />}
          onClick={toggle}
        />
        {children}
      </dialog>
    </div>
  );
}
