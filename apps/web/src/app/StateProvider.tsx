import { useEffect, type PropsWithChildren } from "react";
import { subscribeHousehold } from "../modules/household/subscription";
import { Provider, useAtomValue } from "jotai";
import { QueryClientProvider } from "@tanstack/react-query";
import { appStore } from "./store";
import { queryClient } from "./query-client";
import { saveConfigurationAtom } from "../modules/connections/state";

function AppStateEffects({ children }: PropsWithChildren) {
  useEffect(() => subscribeHousehold(appStore), []);
  // Configuration saves can continue while navigation is resolving.
  useAtomValue(saveConfigurationAtom);
  return children;
}
export function StateProvider({ children }: PropsWithChildren) {
  return (
    <Provider store={appStore}>
      <QueryClientProvider client={queryClient}>
        <AppStateEffects>{children}</AppStateEffects>
      </QueryClientProvider>
    </Provider>
  );
}
