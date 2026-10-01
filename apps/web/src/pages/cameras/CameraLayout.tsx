import { Outlet, useRouterState } from "@tanstack/react-router";
import { PlaybackProvider } from "../../modules/playback/PlaybackProvider";

export default function CameraLayout() {
  const analysisActive = useRouterState({
    select: (state) =>
      state.location.pathname.startsWith("/cameras/") &&
      state.location.pathname !== "/cameras/",
  });
  return (
    <PlaybackProvider analysisActive={analysisActive}>
      <Outlet />
    </PlaybackProvider>
  );
}
