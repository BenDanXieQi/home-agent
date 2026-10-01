import { useEffect } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";

/** Restore the originating camera link after the router commits the list. */
export function useCameraReturnFocus() {
  const router = useRouter();
  useEffect(() => {
    let frame: number | undefined;
    const unsubscribe = router.subscribe(
      "onResolved",
      ({ fromLocation, toLocation }) => {
        if (frame !== undefined) cancelAnimationFrame(frame);
        if (
          toLocation.pathname !== "/cameras" ||
          !fromLocation?.pathname.startsWith("/cameras/")
        )
          return;
        const origin = fromLocation.pathname;
        frame = requestAnimationFrame(() => {
          if (router.state.location.pathname !== "/cameras") return;
          const entry = Array.from(
            document.querySelectorAll<HTMLAnchorElement>(
              "#main-content a[href]",
            ),
          ).find((link) => link.pathname === origin);
          const target = entry ?? document.getElementById("main-content");
          target?.focus({ preventScroll: true });
        });
      },
    );
    return () => {
      unsubscribe();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [router]);
}

export function useCameraReturn() {
  const navigate = useNavigate();
  useEffect(() => {
    const returnToWall = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      navigate({ to: "/cameras" }).catch((error) => {
        console.error("无法返回看家页面", error);
      });
    };
    document.addEventListener("keydown", returnToWall);
    return () => document.removeEventListener("keydown", returnToWall);
  }, [navigate]);
}
