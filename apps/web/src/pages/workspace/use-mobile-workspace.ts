import { useSyncExternalStore } from "react";

const mobileQuery = "(width < 48rem)";

function subscribeMobile(notify: () => void) {
  const query = window.matchMedia(mobileQuery);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

function readMobile() {
  return window.matchMedia(mobileQuery).matches;
}

export function useMobileWorkspace() {
  return useSyncExternalStore(subscribeMobile, readMobile, () => false);
}
