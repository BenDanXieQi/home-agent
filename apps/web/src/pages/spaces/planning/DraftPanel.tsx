import type { ReactNode } from "react";
import { AlertDialog } from "radix-ui";
import { AnimatePresence, m } from "motion/react";
import { ChevronDown } from "lucide-react";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Notice";
import type { compareLayout } from "../../../modules/spatial/layout";
import { expand } from "../../../utils/motion";
import { changeSummary } from "./summary";

type Comparison = ReturnType<typeof compareLayout>;

const states = {
  // Most draft records are new, so only edits to saved records are marked.
  created: null,
  changed: { label: "修改", className: "bg-warning/10 text-warning" },
  removed: { label: "删除", className: "bg-danger/10 text-danger" },
  unchanged: null,
};

function StateBadge({ state }: { state: keyof typeof states }) {
  const badge = states[state];
  return badge ? (
    <span
      className={`shrink-0 rounded-md px-1.5 py-px text-[11px] font-medium ${badge.className}`}
    >
      {badge.label}
    </span>
  ) : null;
}

function DraftItem({
  name,
  detail,
  description,
  state,
}: {
  name: ReactNode;
  detail?: ReactNode;
  description: string;
  state: keyof typeof states;
}) {
  return (
    <li className="grid gap-0.5">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <span
          className={`min-w-0 truncate font-medium ${state === "removed" ? "text-muted line-through" : ""}`}
        >
          {name}
        </span>
        <StateBadge state={state} />
      </span>
      {detail ? <span className="text-xs text-muted">{detail}</span> : null}
      {description ? (
        <span className="line-clamp-2 text-xs leading-5 text-muted">
          {description}
        </span>
      ) : null}
    </li>
  );
}

export function DraftPanel({
  comparison,
  expanded,
  running,
  blocker,
  disabled,
  onToggle,
  onRestart,
  onFinalize,
}: {
  comparison: Comparison;
  expanded: boolean;
  running: boolean;
  blocker: string | null;
  disabled: boolean;
  onToggle: () => void;
  onRestart: () => void;
  onFinalize: () => void;
}) {
  const names = new Map(
    comparison.spaces.map((space) => [space.id, space.name]),
  );
  const summary = changeSummary(comparison.counts);
  return (
    <div className="shrink-0 overflow-hidden rounded-2xl border border-line bg-white">
      <div className="flex items-center gap-2 py-2 pl-2 pr-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls="spatial-draft-detail"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        >
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={`shrink-0 text-muted transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          />
          <span className="grid min-w-0">
            <span className="flex items-baseline gap-2 text-sm font-medium">
              空间草稿
              {running ? (
                <span className="text-xs font-normal text-muted">正在更新</span>
              ) : null}
            </span>
            <span className="truncate text-xs text-muted">
              {comparison.spaces.length} 个空间 · {comparison.passages.length}{" "}
              条通道 · {summary ? `待保存：${summary}` : "与已保存资料一致"}
            </span>
          </span>
        </button>
        <Button
          size="small"
          variant="ghost"
          disabled={disabled}
          onClick={onRestart}
        >
          重新开始
        </Button>
        <Button
          size="small"
          variant="primary"
          disabled={disabled || running || !!blocker || !comparison.changes}
          onClick={onFinalize}
        >
          定稿保存
        </Button>
      </div>
      {blocker ? (
        <p className="border-t border-line px-4 py-2 text-xs leading-5 text-warning">
          {blocker}
        </p>
      ) : null}
      <AnimatePresence initial={false}>
        {expanded ? (
          <m.div
            key="detail"
            id="spatial-draft-detail"
            className="overflow-hidden"
            {...expand}
          >
            <div className="grid max-h-[38dvh] gap-5 overflow-y-auto border-t border-line px-4 py-3 sm:grid-cols-2">
              <section aria-label="空间">
                <h3 className="mb-2 text-xs font-medium text-muted">
                  空间 · {comparison.spaces.length}
                </h3>
                {comparison.spaces.length || comparison.removedSpaces.length ? (
                  <ul className="grid gap-2.5">
                    {comparison.spaces.map((space) => (
                      <DraftItem
                        key={space.id}
                        name={space.name}
                        description={space.description}
                        state={space.state}
                      />
                    ))}
                    {comparison.removedSpaces.map((space) => (
                      <DraftItem
                        key={space.id}
                        name={space.name}
                        description=""
                        state="removed"
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">尚未识别出空间。</p>
                )}
              </section>
              <section aria-label="通道">
                <h3 className="mb-2 text-xs font-medium text-muted">
                  通道 · {comparison.passages.length}
                </h3>
                {comparison.passages.length ||
                comparison.removedPassages.length ? (
                  <ul className="grid gap-2.5">
                    {comparison.passages.map((passage) => (
                      <DraftItem
                        key={passage.id}
                        name={passage.name}
                        detail={`${names.get(passage.space_a_id) ?? "?"} ↔ ${names.get(passage.space_b_id) ?? "?"}`}
                        description={passage.description}
                        state={passage.state}
                      />
                    ))}
                    {comparison.removedPassages.map((passage) => (
                      <DraftItem
                        key={passage.id}
                        name={passage.name}
                        description=""
                        state="removed"
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">尚未识别出通道。</p>
                )}
              </section>
            </div>
          </m.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function FinalizeDialog({
  open,
  comparison,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  comparison: Comparison;
  pending: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const removed = [
    ...comparison.removedSpaces.map((space) => `空间「${space.name}」`),
    ...comparison.removedPassages.map((passage) => `通道「${passage.name}」`),
  ];
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-ink/25" />
        <AlertDialog.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-32px)] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl bg-white p-7 shadow-xl"
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <AlertDialog.Title className="text-xl font-medium">
            保存这份空间草稿？
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-3 text-sm leading-7 text-muted">
            保存后共 {comparison.spaces.length} 个空间、
            {comparison.passages.length} 条通道（
            {changeSummary(comparison.counts)}），并结束本次 AI 规划。
          </AlertDialog.Description>
          {removed.length ? (
            <p className="mt-3 text-sm leading-6 text-danger">
              将删除{removed.join("、")}。
            </p>
          ) : null}
          {error ? (
            <Notice tone="error" className="mb-0 mt-4">
              {error}
            </Notice>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button disabled={pending}>取消</Button>
            </AlertDialog.Cancel>
            <Button
              variant="primary"
              status={pending ? "pending" : "idle"}
              onClick={onConfirm}
            >
              保存
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
