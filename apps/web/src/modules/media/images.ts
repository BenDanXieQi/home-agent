export const imageUploadTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

function hasFiles(event: DragEvent) {
  return !!event.dataTransfer?.types.includes("Files");
}

function over(event: DragEvent) {
  if (hasFiles(event)) event.preventDefault();
}

export function listenForImageDrop(
  element: HTMLElement,
  onFiles: (files: File[]) => void,
  onDragging: (dragging: boolean) => void,
) {
  let depth = 0;
  const enter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    depth++;
    onDragging(true);
  };
  const leave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) onDragging(false);
  };
  const drop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    onDragging(false);
    onFiles([...(event.dataTransfer?.files ?? [])]);
  };

  element.addEventListener("dragenter", enter);
  element.addEventListener("dragover", over);
  element.addEventListener("dragleave", leave);
  element.addEventListener("drop", drop);
  return () => {
    element.removeEventListener("dragenter", enter);
    element.removeEventListener("dragover", over);
    element.removeEventListener("dragleave", leave);
    element.removeEventListener("drop", drop);
  };
}
