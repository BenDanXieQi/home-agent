import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { StateProvider } from "./components/StateProvider";
import { LazyMotion, MotionConfig } from "motion/react";
import { router } from "./router";
import "./index.css";
const loadMotionFeatures = () =>
  import("./lib/motion-features").then((module) => module.default);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StateProvider>
      <LazyMotion features={loadMotionFeatures} strict>
        <MotionConfig reducedMotion="user" transition={{ duration: 0.2 }}>
          <RouterProvider router={router} />
        </MotionConfig>
      </LazyMotion>
    </StateProvider>
  </StrictMode>,
);
