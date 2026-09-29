import { createContext } from "react";

export const PageHeaderContext = createContext<{
  details: HTMLDivElement | null;
  actions: HTMLDivElement | null;
}>({ details: null, actions: null });
