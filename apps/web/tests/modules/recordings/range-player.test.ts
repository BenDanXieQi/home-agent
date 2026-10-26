import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import { RecordingRangePlayer } from "../../../src/modules/recordings/RecordingRangePlayer";

const fixture = vi.hoisted(() => {
  const start = Date.UTC(2030, 0, 1);
  return {
    start,
    state: new Map<number, unknown>(),
    cursor: 0,
    local: false,
    indexEnd: start + 61_000,
    selectionEnd: start + 61_000,
    queriedAt: start,
    localStart: start,
    localEnd: start,
    localFrameEndOffset: 0,
  };
});

vi.mock("react", async () => ({
  ...(await vi.importActual<typeof import("react")>("react")),
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (initial: unknown) => {
    const index = fixture.cursor++;
    if (!fixture.state.has(index)) {
      fixture.state.set(
        index,
        typeof initial === "function"
          ? Reflect.apply(initial, undefined, [])
          : initial,
      );
    }
    return [
      fixture.state.get(index),
      (value: unknown) => {
        fixture.state.set(
          index,
          typeof value === "function"
            ? Reflect.apply(value, undefined, [fixture.state.get(index)])
            : value,
        );
      },
    ];
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ cancelQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    let data: unknown;
    if (queryKey[0] === "ranges") {
      data = {
        ranges: fixture.local
          ? [{ start: fixture.start, end: fixture.selectionEnd }]
          : [],
      };
    } else if (queryKey[0] === "availability") {
      fixture.queriedAt =
        typeof queryKey[1] === "number" ? queryKey[1] : fixture.start;
      data = {
        status: "ready",
        matches: [
          {
            at: fixture.queriedAt,
            clip: { startAt: fixture.start, endAt: fixture.indexEnd },
          },
        ],
      };
    } else if (fixture.local) {
      data = {
        startedAt: fixture.localStart,
        endedAt: fixture.localEnd + fixture.localFrameEndOffset,
        media: [new Blob()],
      };
    }
    return { data, isPending: false, isFetching: false };
  },
}));

vi.mock("../../../src/modules/recordings/api", () => ({
  recordingAvailabilityOptions: (input?: { at: number[] }) => ({
    queryKey: ["availability", input?.at[0]],
  }),
}));

vi.mock("../../../src/modules/recordings/originals", () => ({
  recordingRangesOptions: () => ({ queryKey: ["ranges"] }),
  originalMediaOptions: (
    _scope: string,
    input?: { selection: { start: number; end: number } },
  ) => {
    if (input) {
      fixture.localStart = input.selection.start;
      fixture.localEnd = input.selection.end;
    }
    return { queryKey: ["media", input] };
  },
}));

vi.mock("../../../src/modules/recordings/use-recording-playback", () => ({
  useRecordingPlayback: () => ({
    state: { state: "ready", fileUrl: "/original.mp4" },
    start: vi.fn(),
    cancel: vi.fn(),
  }),
}));

function render() {
  fixture.cursor = 0;
  const target = { deviceId: "camera", channel: 1 as const };
  const nodes: ReactNode[] = [
    RecordingRangePlayer({
      target,
      playbackTarget: { ...target, scope_epoch: "scope", revision: "revision" },
      scope: "scope",
      active: true,
      initialStart: fixture.start,
      initialEnd: fixture.selectionEnd,
    }),
  ];
  let video: ComponentProps<"video"> | undefined;
  const text: string[] = [];
  while (nodes.length) {
    const node = nodes.shift();
    if (typeof node === "string") text.push(node);
    if (!isValidElement<{ children?: ReactNode }>(node)) continue;
    if (
      node.type === "video" &&
      isValidElement<ComponentProps<"video">>(node)
    ) {
      video = node.props;
    }
    nodes.push(...Children.toArray(node.props.children));
  }
  if (!video) throw new Error("Expected range player video");
  return { video, text: text.join("") };
}

function media(currentTime: number, duration = currentTime) {
  return { currentTime, duration, readyState: 4, pause: vi.fn() };
}

function dispatch(
  type: "onEnded" | "onTimeUpdate",
  node: ReturnType<typeof media>,
) {
  const handler = render().video[type];
  if (!handler) throw new Error(`Expected ${type} handler`);
  Reflect.apply(handler, undefined, [{ currentTarget: node }]);
  return render();
}

beforeEach(() => {
  fixture.state.clear();
  fixture.local = false;
  fixture.indexEnd = fixture.start + 61_000;
  fixture.selectionEnd = fixture.start + 61_000;
  fixture.queriedAt = fixture.start;
  fixture.localStart = fixture.start;
  fixture.localEnd = fixture.start;
  fixture.localFrameEndOffset = 0;
});

describe("recording range completion", () => {
  it("reports inconsistent timing when a 61-second indexed final file ends at 60.8 seconds", () => {
    const result = dispatch("onEnded", media(60.8));
    expect(result.text).toContain("原片时间信息与实际时长不一致");
    expect(result.text).not.toContain("所选录像已播放完");
    expect(fixture.queriedAt).toBe(fixture.start);
  });

  it("completes when the actual position reaches the selected endpoint", () => {
    const result = dispatch("onEnded", media(61));
    expect(result.text).toContain("所选录像已播放完");
    expect(result.text).not.toContain("原片时间信息与实际时长不一致");
  });

  it("stops at a selected endpoint inside the original file", () => {
    fixture.selectionEnd = fixture.start + 50_000;
    const node = media(50.2, 60.8);
    const result = dispatch("onTimeUpdate", node);
    expect(node.pause).toHaveBeenCalledOnce();
    expect(node.currentTime).toBe(50);
    expect(result.text).toContain("所选录像已播放完");
  });

  it("advances a nonfinal short file using its indexed endpoint", () => {
    fixture.selectionEnd = fixture.start + 120_000;
    const result = dispatch("onEnded", media(60.8));
    expect(fixture.queriedAt).toBe(fixture.start + 61_000);
    expect(result.video.autoPlay).toBe(true);
    expect(result.text).not.toContain("所选录像已播放完");
    expect(result.text).not.toContain("原片时间信息与实际时长不一致");
  });

  it("completes at the actual endpoint even when the index ends earlier", () => {
    fixture.indexEnd = fixture.start + 60_000;
    const result = dispatch("onEnded", media(61));
    expect(result.text).toContain("所选录像已播放完");
    expect(fixture.queriedAt).toBe(fixture.start);
  });

  it("finishes a validated local range when its encoded duration differs from wall time", () => {
    fixture.local = true;
    fixture.selectionEnd = fixture.start + 25_000;
    fixture.localFrameEndOffset = -0.05;
    const result = dispatch("onEnded", media(24.8));
    expect(result.text).toContain("所选录像已播放完");
    expect(result.text).not.toContain("原片时间信息与实际时长不一致");
  });

  it("reads a long local selection in bounded ranges and completes only after its final range", () => {
    fixture.local = true;
    fixture.selectionEnd = fixture.start + 128_000;
    fixture.localFrameEndOffset = 20;
    render();
    expect(fixture.localEnd - fixture.localStart).toBe(30_000);

    for (let offset = 30_000; offset <= 120_000; offset += 30_000) {
      const result = dispatch("onEnded", media(29.935));
      expect(fixture.localStart).toBe(fixture.start + offset);
      expect(fixture.localEnd).toBe(
        Math.min(fixture.start + offset + 30_000, fixture.selectionEnd),
      );
      expect(result.video.autoPlay).toBe(true);
      expect(result.text).not.toContain("所选录像已播放完");
      expect(result.text).not.toContain("原片时间信息与实际时长不一致");
    }

    const result = dispatch("onEnded", media(7.935));
    expect(result.text).toContain("所选录像已播放完");
    expect(result.text).not.toContain("原片时间信息与实际时长不一致");
  });

  it.each([1, 20])(
    "finishes when the last decoded frame extends %i ms past the prepared range and covers the selected endpoint",
    (frameEndOffset) => {
      fixture.local = true;
      fixture.selectionEnd = fixture.start + 30_001;
      fixture.localFrameEndOffset = frameEndOffset;

      const result = dispatch("onEnded", media(29.935));
      expect(result.text).toContain("所选录像已播放完");
      expect(result.text).not.toContain("原片时间信息与实际时长不一致");
      expect(fixture.localStart).toBe(fixture.start);
      expect(fixture.localEnd).toBe(fixture.start + 30_000);
    },
  );

  it("lets a trimmed local file reach its native end instead of truncating its final frames", () => {
    fixture.local = true;
    fixture.selectionEnd = fixture.start + 25_000;
    const node = media(25, 25.1);
    const result = dispatch("onTimeUpdate", node);
    expect(node.pause).not.toHaveBeenCalled();
    expect(node.currentTime).toBe(25);
    expect(result.text).not.toContain("所选录像已播放完");

    expect(dispatch("onEnded", media(25.1)).text).toContain("所选录像已播放完");
  });
});
