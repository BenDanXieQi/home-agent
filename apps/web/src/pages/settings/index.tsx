import { useAtomValue } from "jotai";
import { ChevronRight, CircleAlert, Hourglass } from "lucide-react";
import { Dialog } from "radix-ui";
import { AccountAvatar } from "../../modules/mijia/AccountAvatar";
import { mijiaAccountLabelAtom } from "../../modules/mijia/login";
import { useMobileWorkspace } from "../workspace/use-mobile-workspace";
import { m } from "motion/react";
import { contentSwap } from "../../utils/motion";
import { mediaBindingAtom } from "../../modules/playback/state";
import { mijiaActionErrorAtom } from "../../modules/mijia/commands";
import {
  connectionNoticeAtom,
  connectionReadinessAtom,
} from "../../modules/connections/state";
import { ServiceConnections } from "./ServiceConnections";
import { RequestFeedback } from "../../components/RequestFeedback";
import { RetryConnectionButton } from "../../modules/mijia/RetryConnectionButton";

import { HomeSelection } from "./HomeSelection";

export default function SettingsPage() {
  const notice = useAtomValue(connectionNoticeAtom);
  const { ready } = useAtomValue(connectionReadinessAtom);
  const binding = useAtomValue(mediaBindingAtom);
  const actionError = useAtomValue(mijiaActionErrorAtom);
  const accountLabel = useAtomValue(mijiaAccountLabelAtom);
  const mobile = useMobileWorkspace();

  return (
    <>
      {mobile ? (
        <Dialog.Trigger asChild>
          <button
            type="button"
            className="mb-6 flex min-h-20 w-full items-center gap-3 rounded-2xl bg-white p-5 text-left shadow-panel hover:bg-black/4 md:hidden"
            aria-haspopup="dialog"
            aria-label={`米家账号，${accountLabel}，管理账户`}
          >
            <AccountAvatar />
            <span className="flex-1">
              <span className="block text-base font-semibold">米家账号</span>
              <span className="mt-1 block text-xs text-muted">
                {accountLabel}
              </span>
            </span>
            <ChevronRight size={18} className="text-muted" aria-hidden="true" />
          </button>
        </Dialog.Trigger>
      ) : null}
      {!ready || notice.attention ? (
        <section
          aria-live="polite"
          className={`relative mb-6 flex w-full items-center gap-4 rounded-2xl p-6 [&_h2]:text-base [&_h2]:font-semibold ${notice.attention ? "bg-ink text-white/80 [&_h2]:text-white" : "bg-white text-muted shadow-panel [&_h2]:text-ink"}`}
        >
          {notice.attention ? (
            <CircleAlert size={18} className="shrink-0" />
          ) : (
            <Hourglass size={18} className="shrink-0" />
          )}
          <m.div key={String(ready)} {...contentSwap}>
            <h2>{notice.title}</h2>
            <p className="mt-1 text-xs">{notice.message}</p>
          </m.div>
        </section>
      ) : null}
      <HomeSelection />
      <ServiceConnections />
      {binding?.status !== "ready" ? (
        <section className="mb-6 flex w-full flex-wrap items-center justify-between gap-4 rounded-2xl bg-white p-6 shadow-panel [&_h2]:text-base [&_h2]:font-semibold">
          <div>
            <h2>米家摄像头接入</h2>
            <p className="mt-2 text-xs leading-6 text-muted">
              {binding?.status === "installing"
                ? "正在接入米家摄像头…"
                : binding?.status === "error"
                  ? binding.error.message
                  : "米家摄像头尚未接入。"}
            </p>
          </div>
          {binding?.status !== "installing" ? (
            <RetryConnectionButton>重新接入</RetryConnectionButton>
          ) : null}
        </section>
      ) : null}
      <RequestFeedback error={actionError} />
    </>
  );
}
