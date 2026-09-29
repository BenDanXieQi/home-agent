import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { queryClient } from "./query-client";

export const appStore = createStore();
appStore.set(queryClientAtom, queryClient);
