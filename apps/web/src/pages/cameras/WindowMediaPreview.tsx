import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../components/Button";
import { Notice, StatusNotice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import {
  windowBytesOptions,
  windowRequestUnavailable,
  type WindowMediaSelection,
} from "../../modules/perception/windows";

export function WindowMediaPreview({
  scope,
  id,
  selection,
  mediaId,
  available,
  active,
}: {
  available: boolean;
  active: boolean;
  scope: string;
  id: string;
  selection: WindowMediaSelection;
  mediaId: string;
}) {
  const query = useQuery({
    ...windowBytesOptions(scope, id, selection, mediaId),
    enabled: (cached) =>
      active && available && !windowRequestUnavailable(cached.state.error),
  });
  const [failed, setFailed] = useState(false);
  const attachMedia = useCallback(
    (node: HTMLMediaElement | null) => {
      if (!query.data || !node) return undefined;
      const url = URL.createObjectURL(query.data);
      node.src = url;
      return () => {
        node.removeAttribute("src");
        node.pause();
        node.load();
        URL.revokeObjectURL(url);
      };
    },
    [query.data],
  );
  if (
    !query.data &&
    (windowRequestUnavailable(query.error) || (!available && !query.isFetching))
  )
    return (
      <StatusNotice className="m-4 max-h-full overflow-auto text-ink">
        此窗口声音已无法读取。
      </StatusNotice>
    );
  if (query.isError)
    return (
      <Notice tone="error" className="m-4 max-h-full overflow-auto">
        媒体读取失败：{requestErrorMessage(query.error)}
        {available ? (
          <Button
            disabled={!active}
            onClick={() => {
              // oxlint-disable-next-line typescript/no-floating-promises
              query.refetch();
            }}
          >
            重试读取
          </Button>
        ) : null}
      </Notice>
    );
  if (!query.data)
    return (
      <StatusNotice className="m-4 max-h-full overflow-auto text-ink">
        {active ? "正在读取窗口声音…" : "等待家庭连接恢复后读取窗口声音。"}
      </StatusNotice>
    );
  if (failed)
    return (
      <Notice tone="error" className="m-4 max-h-full overflow-auto">
        浏览器无法显示该媒体，可能是不支持当前编码或媒体已损坏。
      </Notice>
    );
  return (
    <div className="relative grid size-full place-items-center">
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={attachMedia}
        controls
        aria-label="所选窗口声音"
        className="w-full"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
