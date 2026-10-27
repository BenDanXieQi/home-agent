import { useEffect } from "react";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";

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
  const { member, returnTo } = useSearch({ strict: false });
  useEffect(() => {
    const returnToSource = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      navigate(
        returnTo
          ? { to: returnTo }
          : member
            ? { to: "/members", search: { member } }
            : { to: "/cameras" },
      ).catch((error) => {
        console.error("无法返回来源页面", error);
      });
    };
    document.addEventListener("keydown", returnToSource);
    return () => document.removeEventListener("keydown", returnToSource);
  }, [navigate, member, returnTo]);
}
