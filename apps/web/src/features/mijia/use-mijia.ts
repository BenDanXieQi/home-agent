import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  mijiaStateAtom,
  mijiaReliableAtom,
  mijiaCanStartPlaybackAtom,
  mijiaUpdatedAtAtom,
  mijiaFetchingAtom,
  mijiaFetchErrorAtom,
  mijiaActionErrorAtom,
  mijiaPendingCommandAtom,
  performMijiaAtom,
  refreshMijiaAtom,
} from "./state";

export function useMijia() {
  const perform = useSetAtom(performMijiaAtom);
  const refresh = useSetAtom(refreshMijiaAtom);
  const state = useAtomValue(mijiaStateAtom);
  const snapshotReliable = useAtomValue(mijiaReliableAtom);
  const canStartPlayback = useAtomValue(mijiaCanStartPlaybackAtom);
  const updatedAt = useAtomValue(mijiaUpdatedAtAtom);
  const fetching = useAtomValue(mijiaFetchingAtom);
  const fetchError = useAtomValue(mijiaFetchErrorAtom);
  const actionError = useAtomValue(mijiaActionErrorAtom);
  const action = useAtomValue(mijiaPendingCommandAtom);
  const [enteredAt] = useState(() => Date.now());
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const hasSnapshotSinceMount = updatedAt >= enteredAt;
  return {
    state,
    reliable: snapshotReliable && hasSnapshotSinceMount,
    // Once confirmed on entry, transient refresh errors do not tear down viewers.
    // The backend revokes streams when their owning account/revision changes.
    canPlay: canStartPlayback && hasSnapshotSinceMount,
    confirming: !hasSnapshotSinceMount,
    fetching,
    fetchError,
    actionError,
    action,
    perform,
    refresh,
  };
}
