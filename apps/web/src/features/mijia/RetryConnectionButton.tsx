import type { ComponentProps } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Button } from "../../components/Button";
import {
  mijiaCanRetryConnectionAtom,
  mijiaConnectionBusyAtom,
  performMijiaAtom,
} from "./state";

/** Every connection retry entry shares admission rules and operation feedback. */
export function RetryConnectionButton({
  disabled,
  children = "重新连接",
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick">) {
  const canRetry = useAtomValue(mijiaCanRetryConnectionAtom);
  const busy = useAtomValue(mijiaConnectionBusyAtom);
  const perform = useSetAtom(performMijiaAtom);
  return (
    <Button
      {...props}
      type="button"
      disabled={disabled || !canRetry}
      onClick={() => void perform({ type: "retryConnection" })}
    >
      {busy ? "正在连接…" : children}
    </Button>
  );
}
