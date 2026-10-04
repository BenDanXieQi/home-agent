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
    (node: HTMLImageElement | HTMLMediaElement | null) => {
      if (!query.data || !node) return undefined;
      const url = URL.createObjectURL(query.data);
      node.src = url;
      return () => {
        node.removeAttribute("src");
        if (node instanceof HTMLMediaElement) {
          node.pause();
          node.load();
        }
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
      <StatusNotice>
        此媒体尚未加载，后台已无法读取。请选择新的片段。
      </StatusNotice>
    );
  if (query.isError)
    return (
      <Notice tone="error">
        媒体读取失败：{requestErrorMessage(query.error)}
        {available ? (
          <Button
            disabled={!active}
            onClick={() => {
              // refetch owns request failures and exposes them through query.error.
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
      <StatusNotice>
        {active ? "正在读取片段媒体…" : "等待家庭连接恢复后读取片段媒体。"}
      </StatusNotice>
    );
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">
        已加载到本页，可播放或拖动进度；新片段到来不会关闭。
      </p>
      {failed ? (
        <Notice tone="error">
          浏览器无法显示该媒体，可能是不支持当前编码或媒体已损坏。
        </Notice>
      ) : null}
      {selection.representation.endsWith("image") ? (
        <img
          ref={attachMedia}
          alt="所选窗口的最后一张保留帧"
          className="max-h-[60dvh] w-full rounded-xl bg-black object-contain"
          onError={() => setFailed(true)}
        />
      ) : selection.representation === "audio" ? (
        // Raw camera audio has no transcript; the window summary describes detection only.
        // oxlint-disable-next-line jsx-a11y/media-has-caption
        <audio
          ref={attachMedia}
          controls
          aria-label="所选窗口声音"
          className="w-full"
          onError={() => setFailed(true)}
        />
      ) : (
        // Sampled evidence has no generated captions; do not fabricate a transcript.
        // oxlint-disable-next-line jsx-a11y/media-has-caption
        <video
          ref={attachMedia}
          controls
          playsInline
          aria-label="所选窗口采样视频"
          className="max-h-[60dvh] w-full rounded-xl bg-black"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
