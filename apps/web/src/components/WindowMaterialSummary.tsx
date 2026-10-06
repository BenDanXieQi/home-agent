import type { projectWindowMaterial } from "@home-agent/api/perception/window-observations";
import {
  mediaStateLabel,
  representations,
  windowInputStates,
  petSoundSummary,
} from "../modules/perception/window-presentation";
import { formatTime } from "../modules/presentation/time";

/** Render the supplied version without reading or deriving a newer material state. */
export function WindowMaterialSummary({
  material,
}: {
  material: ReturnType<typeof projectWindowMaterial>;
}) {
  const media = material.sampledMedia;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      <dt className="text-muted">窗口内容修订</dt>
      <dd>{material.revision}</dd>
      <dt className="text-muted">原始音视频</dt>
      <dd>{windowInputStates[material.inputState]}</dd>
      <dt className="text-muted">语音转写</dt>
      <dd>
        {material.speech_enabled ? `${material.speech_count} 段` : "未启用"}
      </dd>
      <dt className="text-muted">猫狗叫声</dt>
      <dd>{petSoundSummary(material)}</dd>
      <dt className="text-muted">片段</dt>
      <dd>{mediaStateLabel(media?.state)}</dd>
      {media ? (
        <>
          <dt className="text-muted">片段生成选项</dt>
          <dd>
            {representations[media.selection.representation]} ·{" "}
            {media.selection.includeAudio ? "包含声音" : "不包含声音"}
          </dd>
          <dt className="text-muted">片段有效期</dt>
          <dd>{formatTime(media.readableUntil, "dateTime")}</dd>
          {media.error ? (
            <>
              <dt className="text-muted">生成原因</dt>
              <dd className="break-words text-danger">{media.error}</dd>
            </>
          ) : null}
        </>
      ) : null}
    </dl>
  );
}
