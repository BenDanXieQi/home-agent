import { cameraTileClassName, cameraGridClassName } from "./camera-styles";
import { CameraHeader } from "./CameraHeader";
import { Skeleton } from "../../components/Skeleton";

/** One camera tile's frame: heading, 16:9 surface and status row, like a live tile. */
export function CameraTileSkeleton() {
  return (
    <article className={cameraTileClassName} aria-hidden="true">
      <CameraHeader title={<Skeleton className="my-[0.2lh] h-[0.6lh] w-28" />}>
        <div className="flex gap-1 shrink-0 flex-nowrap">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="size-8 rounded-md" />
        </div>
      </CameraHeader>
      <div className="relative aspect-video w-full bg-[#111111]" />
      <div className="flex min-h-10 items-center gap-3 overflow-hidden bg-white px-4 py-2 text-muted">
        <Skeleton className="h-3 w-12" />
      </div>
    </article>
  );
}

export function CameraWallSkeleton({ tiles = 3 }: { tiles?: number }) {
  return (
    <output className={cameraGridClassName} aria-label="正在读取摄像头">
      {Array.from({ length: tiles }, (_, index) => (
        <CameraTileSkeleton key={index} />
      ))}
    </output>
  );
}
