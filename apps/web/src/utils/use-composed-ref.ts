import { useCallback, type Ref, type RefObject } from "react";

function attachRef<T>(ref: Ref<T> | undefined, node: T | null) {
  if (typeof ref === "function") {
    const cleanup = ref(node);
    return () => {
      if (typeof cleanup === "function") cleanup();
      else ref(null);
    };
  }
  if (ref) ref.current = node;
  return () => {
    if (ref) ref.current = null;
  };
}

/** Shares one DOM node with internal measurement and the caller's React ref. */
export function useComposedRef<T>(
  localRef: RefObject<T | null>,
  ref: Ref<T> | undefined,
) {
  return useCallback(
    (node: T | null) => {
      const clearLocal = attachRef(localRef, node);
      const clearRef = attachRef(ref, node);
      return () => {
        clearLocal();
        clearRef();
      };
    },
    [localRef, ref],
  );
}
