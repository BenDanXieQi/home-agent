import { useAtomValue, useSetAtom } from "jotai";
import {
  mijiaStateAtom,
  mijiaReliableAtom,
  mijiaCanStartPlaybackAtom,
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
  const fetching = useAtomValue(mijiaFetchingAtom);
  const fetchError = useAtomValue(mijiaFetchErrorAtom);
  const actionError = useAtomValue(mijiaActionErrorAtom);
  const action = useAtomValue(mijiaPendingCommandAtom);
  return {
    state,
    reliable: snapshotReliable,
    // Once confirmed on entry, transient refresh errors do not tear down viewers.
    // The backend revokes streams when their owning account/revision changes.
    canPlay: canStartPlayback,
    confirming: !state,
    fetching,
    fetchError,
    actionError,
    action,
    perform,
    refresh,
  };
}
