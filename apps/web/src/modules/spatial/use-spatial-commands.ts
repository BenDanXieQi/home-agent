import { sameSpatialScope } from "@home-agent/api/spatial";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RequestError } from "../../api/errors";
import {
  spatialQueryOptions,
  executeSpatialCommand,
  confirmSpatialCommand,
  type SpatialCommand,
  type SpatialSnapshot,
} from "./api";

function replaceRecord<T extends { id: string }>(records: T[], record: T) {
  return records.some((item) => item.id === record.id)
    ? records.map((item) => (item.id === record.id ? record : item))
    : [...records, record];
}
export function useSpatialCommands(
  scope: string,
  onCompleted: (
    result:
      | Awaited<ReturnType<typeof executeSpatialCommand>>
      | { status: "confirmed" },
  ) => void,
) {
  const client = useQueryClient();
  const options = spatialQueryOptions(scope);
  const [unconfirmed, setUnconfirmed] = useState<SpatialCommand | null>(null);
  const [checking, setChecking] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmationError, setConfirmationError] = useState<unknown>(null);
  async function confirm(command: SpatialCommand) {
    setChecking(true);
    setConfirmationError(null);
    try {
      await client.cancelQueries({ queryKey: options.queryKey });
      const snapshot = await client.fetchQuery({ ...options, staleTime: 0 });
      const result = confirmSpatialCommand(command, snapshot);
      setUnconfirmed(null);
      if (result === "confirmed") {
        setMessage("已重新读取并确认操作结果。");
        onCompleted({ status: "confirmed" });
      } else if (result === "not-applied") {
        setMessage("重新读取后未发现这次更改，输入已保留，可核对后再次提交。");
      } else {
        setBlocked(true);
        setMessage(
          result === "scope-changed"
            ? "家庭绑定已变化，请读取当前家庭资料后继续。"
            : "这条资料已变化，输入已保留。请读取最新记录后重新编辑。",
        );
      }
    } catch (error) {
      setConfirmationError(error);
      setMessage("尚不能确认操作是否已完成。恢复连接后请先读取确认。");
    } finally {
      setChecking(false);
    }
  }
  const mutation = useMutation({
    mutationFn: executeSpatialCommand,
    onMutate: () => {
      setMessage("");
      setConfirmationError(null);
    },
    onSuccess: async (result, command) => {
      await client.cancelQueries({ queryKey: options.queryKey });
      client.setQueryData(
        options.queryKey,
        (current: SpatialSnapshot | undefined) => {
          if (
            !current ||
            !sameSpatialScope(command.input.scope, current.scope) ||
            result.status === "referenced"
          )
            return current;
          if (result.status === "saved") {
            if (result.resource === "space")
              return {
                ...current,
                spaces: replaceRecord(current.spaces, result.record),
              };
            if (result.resource === "passage")
              return {
                ...current,
                passages: replaceRecord(current.passages, result.record),
              };
            return {
              ...current,
              observation_bindings: replaceRecord(
                current.observation_bindings,
                result.record,
              ),
            };
          }
          if (command.resource === "space")
            return {
              ...current,
              spaces: current.spaces.filter(
                (record) => record.id !== result.id,
              ),
            };
          if (command.resource === "passage")
            return {
              ...current,
              passages: current.passages.filter(
                (record) => record.id !== result.id,
              ),
            };
          return {
            ...current,
            observation_bindings: current.observation_bindings.filter(
              (record) => record.id !== result.id,
            ),
          };
        },
      );
      onCompleted(result);
      await client.invalidateQueries({ queryKey: options.queryKey });
    },
    onError: async (error, command) => {
      if (!(error instanceof RequestError)) return;
      if (
        (error.status !== undefined && error.status >= 500) ||
        [
          "network_error",
          "request_timeout",
          "request_cancelled",
          "invalid_response",
          "spatial_storage_unavailable",
        ].includes(error.details.code)
      ) {
        setUnconfirmed(command);
        setMessage("响应未能确认操作结果，正在重新读取…");
        await confirm(command);
      } else if (
        [
          "spatial_record_changed",
          "spatial_record_exists",
          "spatial_scope_changed",
          "not_found",
        ].includes(error.details.code)
      ) {
        setBlocked(true);
        setMessage(
          "资料或家庭绑定已变化，输入已保留。请读取最新记录后重新编辑。",
        );
      }
    },
  });
  function reset() {
    mutation.reset();
    setMessage("");
    setBlocked(false);
    setUnconfirmed(null);
    setConfirmationError(null);
  }
  return {
    submit: mutation.mutate,
    pending: mutation.isPending || checking || !!unconfirmed || blocked,
    error: mutation.isError && !message ? mutation.error : confirmationError,
    message,
    checking,
    blocked,
    unconfirmed: !!unconfirmed,
    confirm: async () => {
      if (unconfirmed) await confirm(unconfirmed);
    },
    reset,
  };
}
