import type { z } from "zod";
import type { audioTrackSchema } from "@home-agent/api/contracts";
import type { pcmSchema } from "../audio/pcm";

export function createWindowAudio() {
  return {
    audio: [] as {
      pcm: Int16Array;
      startedAt: number;
      endedAt: number;
      startSample: number;
      energy: z.infer<typeof audioTrackSchema>["energy"];
      vad: z.infer<typeof audioTrackSchema>["vad"];
    }[],
    audioTrack: null as z.infer<typeof audioTrackSchema> | null,
  };
}
export function createWindowAudioContext() {
  return { ...createWindowAudio(), gaps: new Set<string>() };
}
type AudioWindow = ReturnType<typeof createWindowAudio> & {
  startedAt: number;
  endedAt: number;
  gaps: Set<string>;
};
export function recordAudioStatus(
  value: AudioWindow,
  track: z.infer<typeof audioTrackSchema>,
) {
  // A later failure must not rewrite a fully covered window waiting for closure.
  const last = value.audio.at(-1);
  if (last && last.endedAt >= value.endedAt - 1 / 16) return;
  if (track.status === "failed" || track.status === "unavailable")
    value.gaps.add("audio_failed");
  else if (track.validity === "expired") value.gaps.add("audio_gap");
  if (track.vadStatus === "unavailable") value.gaps.add("vad_unavailable");
}
export function appendWindowAudio(
  value: Pick<AudioWindow, "audio" | "audioTrack" | "gaps">,
  track: z.infer<typeof audioTrackSchema>,
  pcm: z.infer<typeof pcmSchema>,
  offset: number,
  end: number,
  at: number,
) {
  const startSample = track.samples - pcm.length;
  const previous = value.audio.at(-1);
  if (
    value.audioTrack &&
    (value.audioTrack.run.trackRunId !== track.run.trackRunId ||
      value.audioTrack.generation !== track.generation)
  ) {
    value.gaps.add("audio_generation_changed");
    return 0;
  }
  if (previous && at < previous.endedAt - 0.1) {
    value.gaps.add("audio_overlap");
    return 0;
  }
  if (previous && at - previous.endedAt > 1) value.gaps.add("audio_gap");
  value.audioTrack = track;
  value.audio.push({
    // Full IPC-owned blocks can be shared by both camera channels. Split views
    // need compact storage so retained-byte accounting includes their backing buffer.
    pcm:
      offset === 0 &&
      end === pcm.length &&
      pcm.byteLength === pcm.buffer.byteLength
        ? pcm
        : pcm.slice(offset, end),
    startedAt: at,
    endedAt: at + (end - offset) / 16,
    startSample: startSample + offset,
    energy: track.energy.filter(
      (block) =>
        block.endSample > startSample + offset &&
        block.endSample <= startSample + end,
    ),
    vad: track.vad.filter(
      (block) =>
        block.endSample > startSample + offset &&
        block.endSample <= startSample + end,
    ),
  });
  return (end - offset) * 2;
}
export function summarizeWindowAudio(
  value: AudioWindow,
  latest: z.infer<typeof audioTrackSchema> | null,
) {
  const track = value.audioTrack ?? latest;
  const energy = value.audio.flatMap((block) => block.energy);
  const vad = value.audio.flatMap((block) => block.vad);
  const speechBlocks = vad.filter((block) => block.aboveThreshold).length;
  const first = value.audio[0],
    last = value.audio.at(-1);
  // A sample can straddle the window edge; tolerate at most one sample.
  if (first && first.startedAt - value.startedAt > 1 / 16)
    value.gaps.add("audio_head_gap");
  if (last && value.endedAt - last.endedAt > 1 / 16)
    value.gaps.add("audio_tail_gap");
  // Preceding context is copied from a rolling buffer, so recheck its internal
  // coverage rather than inheriting historical gap flags after they age out.
  for (let index = 1; index < value.audio.length; index++) {
    const difference =
      value.audio[index]!.startedAt - value.audio[index - 1]!.endedAt;
    if (difference > 1) value.gaps.add("audio_gap");
    else if (difference < -0.1) value.gaps.add("audio_overlap");
  }
  const interrupted = [
    "audio_gap",
    "audio_head_gap",
    "audio_tail_gap",
    "audio_overlap",
    "audio_generation_changed",
    "audio_capacity",
  ].some((gap) => value.gaps.has(gap));
  const status = value.gaps.has("audio_failed")
    ? ("failed" as const)
    : interrupted
      ? ("insufficient_input" as const)
      : value.audio.length
        ? ("available" as const)
        : track?.status === "no_track"
          ? ("no_track" as const)
          : track?.status === "failed" || track?.status === "unavailable"
            ? ("failed" as const)
            : track?.status === "reading"
              ? ("insufficient_input" as const)
              : ("missing" as const);
  if (status !== "available") value.gaps.add(`audio_${status}`);
  const petStatus =
    track?.petSounds?.status === "unavailable"
      ? ("unavailable" as const)
      : ("insufficient_input" as const);
  return {
    status,
    petSounds: track?.petSounds && {
      ...track.petSounds,
      status: petStatus,
      validity:
        petStatus === "unavailable"
          ? ("unavailable" as const)
          : ("no_data" as const),
      error: petStatus === "unavailable" ? track.petSounds.error : undefined,
      chunks: [],
    },
    run: track?.run ?? null,
    generation: track?.generation ?? null,
    startedAt: first?.startedAt ?? null,
    endedAt: last?.endedAt ?? null,
    samples: value.audio.reduce((sum, block) => sum + block.pcm.length, 0),
    energyBlocks: energy.length,
    activeEnergyBlocks: energy.filter((block) => block.active).length,
    peakRms: energy.reduce((peak, block) => Math.max(peak, block.rms), 0),
    speechBlocks,
    vad:
      value.gaps.has("vad_unavailable") ||
      track?.vadStatus === "unavailable" ||
      status === "failed"
        ? ("unavailable" as const)
        : status !== "available" || vad.length < 3
          ? ("insufficient_input" as const)
          : speechBlocks >= 3
            ? ("speech" as const)
            : ("no_speech" as const),
  };
}

export function trimWindowAudio(value: AudioWindow, endedAt: number) {
  value.audio = value.audio.flatMap((block) => {
    if (block.startedAt >= endedAt) return [];
    if (block.endedAt <= endedAt) return [block];
    const samples = Math.floor((endedAt - block.startedAt) * 16);
    if (samples <= 0) return [];
    const endSample = block.startSample + samples;
    return [
      {
        ...block,
        pcm: block.pcm.slice(0, samples),
        endedAt: block.startedAt + samples / 16,
        energy: block.energy.filter((item) => item.endSample <= endSample),
        vad: block.vad.filter((item) => item.endSample <= endSample),
      },
    ];
  });
}
