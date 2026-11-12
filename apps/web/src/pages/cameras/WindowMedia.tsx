import { Button } from "../../components/Button";
import { Notice, StatusNotice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import {
  type PerceptionWindow,
  windowRequestUnavailable,
} from "../../modules/perception/windows";
import { useWindowMedia } from "../../modules/perception/use-window-media";
import {
  useWindowInputState,
  useWindowMediaState,
} from "../../modules/perception/use-window-input-state";
import { mediaStates } from "../../modules/perception/window-presentation";
import { WindowMediaPreview } from "./WindowMediaPreview";

export function WindowMedia({
  window,
  scope,
  active,
}: {
  window: PerceptionWindow;
  scope: string;
  active: boolean;
}) {
  const selection = { representation: "audio" as const, includeAudio: false };
  const canGenerate = useWindowInputState(window) === "available";
  const { query, mutation, error } = useWindowMedia(
    scope,
    window.id,
    selection,
    active,
  );
  const media = query.data;
  const state = useWindowMediaState(media);
  return (
    <section
      aria-label="窗口声音"
      className="space-y-3 rounded-xl border border-line p-3"
    >
      <h3 className="text-sm font-medium">窗口声音</h3>
      {media?.state === "ready" && media.mediaId ? (
        <WindowMediaPreview
          key={media.mediaId}
          scope={scope}
          id={window.id}
          selection={selection}
          mediaId={media.mediaId}
          available={state === "ready"}
          active={active}
        />
      ) : (
        <StatusNotice>
          {windowRequestUnavailable(error)
            ? "此观察的声音已不可读取。"
            : state
              ? mediaStates[state]
              : "正在查询声音…"}
        </StatusNotice>
      )}
      {error && !windowRequestUnavailable(error) ? (
        <Notice tone="error">{requestErrorMessage(error)}</Notice>
      ) : null}
      {query.isError && !windowRequestUnavailable(error) ? (
        <Button
          disabled={!active || query.isFetching}
          onClick={() => query.refetch()}
        >
          重试查询声音
        </Button>
      ) : null}
      {canGenerate && (state === "not_generated" || state === "failed") ? (
        <Button
          disabled={!active || mutation.isPending}
          onClick={() => mutation.mutate(state === "failed")}
        >
          {state === "failed" ? "重试生成声音" : "读取窗口声音"}
        </Button>
      ) : null}
      <p className="text-xs leading-5 text-muted">
        声音单独短期保留，与本地原始视频的可用范围独立。
      </p>
    </section>
  );
}
