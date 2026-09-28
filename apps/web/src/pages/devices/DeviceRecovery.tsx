import { useAtomValue, useSetAtom } from "jotai";
import { Notice } from "../../components/Notice";
import { Button } from "../../components/Button";
import {
  deviceCapabilityFailureCountAtom,
  deviceInventoryAtom,
} from "../../modules/devices/state";
import { mijiaAuthenticatedAtom } from "../../modules/mijia/account";
import {
  mijiaCommandOutcomeAtom,
  performMijiaAtom,
} from "../../modules/mijia/commands";

export function DeviceRecovery() {
  const inventory = useAtomValue(deviceInventoryAtom);
  const capabilityFailures = useAtomValue(deviceCapabilityFailureCountAtom);
  const authenticated = useAtomValue(mijiaAuthenticatedAtom);
  const outcome = useAtomValue(mijiaCommandOutcomeAtom);
  const perform = useSetAtom(performMijiaAtom);
  const directoryFailed = inventory?.status === "error";
  if (!directoryFailed && !capabilityFailures) return null;
  const retrying =
    outcome.type === "refreshDevices" && outcome.status === "pending";
  return (
    <>
      {capabilityFailures > 0 ? (
        <Notice tone="warning">
          {capabilityFailures}{" "}
          台设备的能力信息获取失败，部分支持的功能暂时无法显示。
        </Notice>
      ) : null}
      <div className="mb-4">
        <Button
          disabled={
            !inventory || !authenticated || outcome.status === "pending"
          }
          status={retrying ? "pending" : "idle"}
          onClick={() =>
            void perform({
              type: "refreshDevices",
              target: directoryFailed ? "all" : "specs",
            })
          }
        >
          {retrying ? "正在重试…" : "重试"}
        </Button>
      </div>
    </>
  );
}
