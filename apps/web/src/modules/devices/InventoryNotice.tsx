import { useAtomValue } from "jotai";
import { Notice } from "../../components/Notice";
import { deviceInventoryAtom } from "./state";

export function InventoryNotice() {
  const inventory = useAtomValue(deviceInventoryAtom);
  return inventory?.status === "error" ? (
    <Notice tone="error">
      {inventory.items.length
        ? "设备刷新失败，保留上次读取的列表。"
        : "设备读取失败。"}
      {inventory.error?.message}
    </Notice>
  ) : null;
}
