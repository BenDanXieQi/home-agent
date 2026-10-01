import { useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import { HouseholdAccess } from "../../modules/household/HouseholdAccess";
import { householdSnapshotAtom } from "../../modules/household/state";
import {
  deviceInventoryAtom,
  cameraCountAtom,
} from "../../modules/devices/state";
import { InventoryNotice } from "../../modules/devices/InventoryNotice";
import { mediaStateAtom } from "../../modules/playback/state";
import { canStartPlaybackAtom } from "../../modules/playback/access";
import { RetryConnectionButton } from "../../modules/mijia/RetryConnectionButton";
import { Notice, StatusNotice } from "../../components/Notice";
import {
  PageHeaderCount,
  PageHeaderContent,
} from "../../components/PageHeaderContent";
import { buttonStyles } from "../../components/button-styles";
import { ImagePlus } from "lucide-react";
import CameraWall from "./CameraWall";
import { CameraWallSkeleton } from "./skeletons";

export default function CamerasPage() {
  const inventory = useAtomValue(deviceInventoryAtom);
  const count = useAtomValue(cameraCountAtom);
  const media = useAtomValue(mediaStateAtom);
  const ready = useAtomValue(canStartPlaybackAtom);
  const snapshot = useAtomValue(householdSnapshotAtom);
  return (
    <>
      <PageHeaderContent slot="actions">
        <Link
          to="/cameras/images"
          className={`${buttonStyles.base} ${buttonStyles.secondary}`}
        >
          <ImagePlus size={15} aria-hidden="true" /> 图片分析
        </Link>
      </PageHeaderContent>
      <PageHeaderCount
        count={count}
        loading={!inventory || inventory.status === "loading"}
        label="摄像头"
      />
      <InventoryNotice />
      {inventory?.status === "error" ? (
        <Link to="/devices" className="mb-4 inline-block text-sm underline">
          前往房间页重试
        </Link>
      ) : null}
      <HouseholdAccess fallback={<CameraWallSkeleton />}>
        {inventory && media && snapshot ? (
          <>
            {media.binding.status === "error" ? (
              <Notice tone="error">
                <span>{media.binding.error.message}</span>
                <RetryConnectionButton />
              </Notice>
            ) : media.binding.status === "installing" ? (
              <StatusNotice>正在连接摄像头服务…</StatusNotice>
            ) : null}
            <CameraWall
              key={snapshot.scope_epoch}
              scope_epoch={snapshot.scope_epoch}
              devices={inventory}
              revision={media.revision}
              ready={ready}
            />
          </>
        ) : null}
      </HouseholdAccess>
    </>
  );
}
