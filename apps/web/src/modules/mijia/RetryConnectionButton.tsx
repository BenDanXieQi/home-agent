import type { ComponentProps } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Button } from "../../components/Button";
import {
  mijiaCanRetryConnectionAtom,
  mijiaConnectionBusyAtom,
} from "./connection";
import { mijiaCommandOutcomeAtom, performMijiaAtom } from "./commands";
import { mediaBindingAtom } from "../playback/state";

/** Every connection retry entry shares admission rules and operation feedback. */
export function RetryConnectionButton({
  disabled,
  children = "重新连接",
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick" | "status" | "type">) {
  const canRetry = useAtomValue(mijiaCanRetryConnectionAtom);
  const busy = useAtomValue(mijiaConnectionBusyAtom);
  const perform = useSetAtom(performMijiaAtom);
  const outcome = useAtomValue(mijiaCommandOutcomeAtom);
  const binding = useAtomValue(mediaBindingAtom);
  // The command only starts the connection; its end is the binding settling.
  const status = busy
    ? "pending"
    : outcome.type !== "retryConnection"
      ? "idle"
      : outcome.status === "error" || binding?.status === "error"
        ? "error"
        : outcome.status;
  return (
    <Button
      {...props}
      status={status}
      type="button"
      disabled={disabled || !canRetry}
      onClick={() => void perform({ type: "retryConnection" })}
    >
      {busy ? "正在连接…" : children}
    </Button>
  );
}
