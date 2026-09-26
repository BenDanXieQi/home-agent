import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CameraWall from "../src/features/mijia/CameraWall";
import { device, mediaRevision } from "./support/household";

describe("camera availability display", () => {
  it.each([
    { availability: "unknown", online: false, offlineNotice: false },
    { availability: "offline", online: true, offlineNotice: true },
  ] as const)(
    "uses $availability runtime availability when cloud online is $online",
    ({ availability, online, offlineNotice }) => {
      const html = renderToStaticMarkup(
        createElement(CameraWall, {
          devices: {
            status: "ready",
            items: [
              device({ camera: true, channels: [1], availability, online }),
            ],
            error: null,
          },
          revision: mediaRevision,
          ready: false,
          confirming: false,
        }),
      );
      expect(html.includes("设备当前离线")).toBe(offlineNotice);
    },
  );
});
