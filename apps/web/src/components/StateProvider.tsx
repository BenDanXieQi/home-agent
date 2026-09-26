import { useEffect, type ReactNode } from "react";
import { subscribeHousehold } from "../features/mijia/subscription";
import { Provider, useAtomValue } from "jotai";
import { QueryClientProvider } from "@tanstack/react-query";
import { appStore } from "../lib/store";
import { queryClient } from "../lib/query-client";
import { saveConfigurationAtom } from "../features/connections/state";

function MutationLifetime({ children }: { children: ReactNode }) {
  useEffect(subscribeHousehold, []);
  // Configuration saves can continue while navigation is resolving.
  useAtomValue(saveConfigurationAtom);
  return children;
}
export function StateProvider({ children }: { children: ReactNode }) {
  return (
    <Provider store={appStore}>
      <QueryClientProvider client={queryClient}>
        <MutationLifetime>{children}</MutationLifetime>
      </QueryClientProvider>
    </Provider>
  );
}
