import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { StateProvider } from "./app/StateProvider";
import { LazyMotion, MotionConfig } from "motion/react";
import { router } from "./router";
import { spring } from "./utils/motion";
import "./index.css";
const loadMotionFeatures = () =>
  import("./utils/motion-features").then((module) => module.default);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StateProvider>
      <LazyMotion features={loadMotionFeatures} strict>
        <MotionConfig reducedMotion="user" transition={spring}>
          <RouterProvider router={router} />
        </MotionConfig>
      </LazyMotion>
    </StateProvider>
  </StrictMode>,
);
