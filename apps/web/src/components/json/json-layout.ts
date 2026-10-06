// Named system fonts are available to both the DOM and worker canvas without a web-font race.
export const jsonFont =
  '13px "Courier New", "PingFang SC", "Noto Sans CJK SC", monospace';
export const jsonLineHeight = 20;

export type JsonLayoutRequest = {
  requestId: number;
  width: number;
} & ({ kind: "prepare"; value: unknown; locale: string } | { kind: "resize" });
