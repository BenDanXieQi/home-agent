import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import { RecordingRangePlayer } from "../../../src/modules/recordings/RecordingRangePlayer";
import { Button } from "../../../src/components/Button";

const fixture = vi.hoisted(() => {
  const start = Date.UTC(2030, 0, 1);
  return {
    start,
    state: new Map<number, unknown>(),
    cursor: 0,
    local: false,
    clips: [{ startAt: start, endAt: start + 61_000 }],
    selectionStart: start + 11_000,
    selectionEnd: start + 15_000,
    observedAt: undefined as number | undefined,
    queriedAt: [] as number[],
    localRangeStart: start,
    localRangeEnd: start + 180_000,
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
          ? [{ start: fixture.localRangeStart, end: fixture.localRangeEnd }]
          : [],
      };
    } else if (queryKey[0] === "availability") {
      fixture.queriedAt = Array.isArray(queryKey[1]) ? queryKey[1] : [];
      data = {
        status: "ready",
        matches: fixture.queriedAt.map((at) => ({
          at,
          clip:
            fixture.clips.find(
              (clip) => clip.startAt <= at && at < clip.endAt,
            ) ?? null,
        })),
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
    queryKey: ["availability", input?.at],
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
      initialStart: fixture.selectionStart,
      initialEnd: fixture.selectionEnd,
      observedAt: fixture.observedAt,
    }),
  ];
  let video: ComponentProps<"video"> | undefined;
  const buttons = new Map<string, ComponentProps<typeof Button>>();
  const inputs: ComponentProps<"input">[] = [];
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
    if (
      node.type === Button &&
      isValidElement<ComponentProps<typeof Button>>(node) &&
      typeof node.props.children === "string"
    )
      buttons.set(node.props.children, node.props);
    if (node.type === "input" && isValidElement<ComponentProps<"input">>(node))
      inputs.push(node.props);
    nodes.push(...Children.toArray(node.props.children));
  }
  if (!video) throw new Error("Expected range player video");
  return { video, text: text.join(""), buttons, inputs };
}

function media(currentTime: number, duration = currentTime) {
  return { currentTime, duration, readyState: 4, pause: vi.fn() };
}

function dispatch(
  type:
    | "onEnded"
    | "onTimeUpdate"
    | "onSeeking"
    | "onLoadedMetadata"
    | "onPlay",
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
  fixture.clips = [{ startAt: fixture.start, endAt: fixture.start + 61_000 }];
  fixture.selectionStart = fixture.start + 11_000;
  fixture.selectionEnd = fixture.start + 15_000;
  fixture.observedAt = undefined;
  fixture.queriedAt = [];
  fixture.localRangeStart = fixture.start;
  fixture.localRangeEnd = fixture.start + 180_000;
  fixture.localStart = fixture.start;
  fixture.localEnd = fixture.start;
  fixture.localFrameEndOffset = 0;
});

describe("recording context playback", () => {
  it("looks before and after a short observation and still finds its file when earlier context is missing", () => {
    const result = render();
    expect(fixture.queriedAt).toEqual([
      fixture.start - 19_000,
      fixture.start + 11_000,
    ]);
    expect(new Date(String(result.inputs[0]?.value)).getTime()).toBe(
      fixture.selectionStart - 30_000,
    );
    expect(new Date(String(result.inputs[1]?.value)).getTime()).toBe(
      fixture.selectionEnd + 30_000,
    );
    expect(result.text).not.toContain("录像缺口");
    expect(result.buttons.get("向前查看")?.disabled).toBe(false);
  });

  it.each(["onTimeUpdate", "onSeeking", "onPlay"] as const)(
    "%s allows the whole original file on both sides of the observation",
    (type) => {
      for (const position of [0, 15, 50]) {
        const node = media(position, 61);
        const result = dispatch(type, node);
        expect(node.pause).not.toHaveBeenCalled();
        expect(node.currentTime).toBe(position);
        expect(result.text).not.toContain("已播放完");
      }
    },
  );

  it.each([60.8, 61])(
    "completes only when the final file naturally ends at %s seconds",
    (duration) => {
      const result = dispatch("onEnded", media(duration));
      expect(result.text).toContain("本次录像已播放完");
      expect(result.text).not.toContain("原片时间信息与实际时长不一致");
    },
  );

  it("continues across SD files to include the context after a long observation", () => {
    fixture.selectionEnd = fixture.start + 120_000;
    fixture.clips = [0, 61_000, 122_000].map((offset) => ({
      startAt: fixture.start + offset,
      endAt: fixture.start + offset + 61_000,
    }));

    for (const offset of [61_000, 122_000]) {
      const result = dispatch("onEnded", media(60.8));
      expect(fixture.queriedAt).toEqual([fixture.start + offset]);
      expect(result.video.autoPlay).toBe(true);
      expect(result.text).not.toContain("已播放完");
    }
    expect(dispatch("onEnded", media(60.8)).text).toContain("本次录像已播放完");
  });

  it("keeps a recording gap visible when neither the context nor the observation has a file", () => {
    fixture.clips = [];
    expect(render().text).toContain("所选时间存在录像缺口");
  });

  it("reads available local context even when its start is later than the requested context", () => {
    fixture.local = true;
    render();
    expect(fixture.localStart).toBe(fixture.start);
    expect(fixture.localEnd).toBe(fixture.start + 30_000);
    const result = dispatch("onLoadedMetadata", media(0, 29.9));
    expect(result.text).not.toContain("未被原片覆盖");

    expect(dispatch("onEnded", media(29.9)).text).not.toContain("已播放完");
    expect(fixture.localStart).toBe(fixture.start + 30_000);
    expect(fixture.localEnd).toBe(fixture.start + 45_000);
    expect(dispatch("onEnded", media(14.9)).text).toContain("本次录像已播放完");
  });

  it("does not skip a gap before the observation when continuing from earlier footage", () => {
    fixture.clips = [
      { startAt: fixture.start - 30_000, endAt: fixture.start - 10_000 },
      { startAt: fixture.start, endAt: fixture.start + 61_000 },
    ];
    const result = dispatch("onEnded", media(20));
    expect(fixture.queriedAt).toEqual([fixture.start - 10_000]);
    expect(result.text).toContain("所选时间存在录像缺口");
  });

  it("reads long local context in bounded ranges through its final frame", () => {
    fixture.local = true;
    fixture.selectionEnd = fixture.start + 120_000;
    fixture.localFrameEndOffset = 20;
    render();
    expect(fixture.localEnd - fixture.localStart).toBe(30_000);

    for (let offset = 30_000; offset < 150_000; offset += 30_000) {
      const result = dispatch("onEnded", media(29.935));
      expect(fixture.localStart).toBe(fixture.start + offset);
      expect(fixture.localEnd - fixture.localStart).toBe(30_000);
      expect(result.video.autoPlay).toBe(true);
      expect(result.text).not.toContain("已播放完");
    }
    expect(dispatch("onEnded", media(29.935)).text).toContain(
      "本次录像已播放完",
    );
  });

  it("uses the selected evidence time to find local context for a long activity", () => {
    fixture.local = true;
    fixture.selectionStart = fixture.start - 120_000;
    fixture.selectionEnd = fixture.start + 120_000;
    fixture.observedAt = fixture.start + 90_000;
    render();
    expect(fixture.localStart).toBe(fixture.start + 60_000);
    expect(fixture.localEnd).toBe(fixture.start + 90_000);
  });

  it("lets local files reach their native end even when the final encoded frame extends past the range", () => {
    fixture.local = true;
    dispatch("onEnded", media(29.9));
    const node = media(15, 15.1);
    expect(dispatch("onTimeUpdate", node).text).not.toContain("已播放完");
    expect(node.pause).not.toHaveBeenCalled();
    expect(dispatch("onEnded", media(15.1)).text).toContain("本次录像已播放完");
  });

  it("opens earlier and later context beyond the original observation", () => {
    fixture.clips = [-61_000, 0, 61_000].map((offset) => ({
      startAt: fixture.start + offset,
      endAt: fixture.start + offset + 61_000,
    }));
    const before = render().buttons.get("向前查看")?.onClick;
    if (!before) throw new Error("Expected earlier recording control");
    Reflect.apply(before, undefined, []);
    const earlier = render();
    expect(new Date(String(earlier.inputs[0]?.value)).getTime()).toBe(
      fixture.start - 121_000,
    );

    fixture.state.clear();
    const after = render().buttons.get("继续向后看")?.onClick;
    if (!after) throw new Error("Expected later recording control");
    Reflect.apply(after, undefined, []);
    const later = render();
    expect(new Date(String(later.inputs[0]?.value)).getTime()).toBe(
      fixture.start,
    );
    expect(later.video.autoPlay).toBe(true);
  });
});
