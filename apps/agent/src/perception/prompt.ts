import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { compileConversationInput } from "../prompts";
import type { MediaAnalysisInput } from "./analysis";

const userTemplates = {
  profile: 0,
  rules: 1,
  history: 2,
  main: 3,
  gallery: 4,
  body: 5,
  face: 6,
  galleryEnd: 7,
  galleryEmpty: 8,
  bbox: 9,
  pets: 10,
  petsEnd: 11,
  panorama: 12,
  personCrops: 13,
  personCrop: 14,
  panoramaBbox: 15,
  imageSequence: 16,
} as const;

const fieldOrder = [
  "identities",
  "pet_identities",
  "caption",
  "speeches",
  "env_sounds",
  "matched_rules",
  "suggestions",
] as const;

function text(value: string) {
  return { type: "text" as const, text: value };
}

function user(
  content: Array<
    | TextContent
    | ImageContent
    | {
        type: "media";
        media: Exclude<MediaAnalysisInput["media"], { kind: "images" }>;
      }
  >,
) {
  return { role: "user" as const, content };
}

export function prepareMediaPrompt(input: MediaAnalysisInput) {
  const { media, context, identity, pets, panorama } = input;
  const isVisual = media.kind !== "audio";
  const isImages = media.kind === "images";
  if (
    isImages &&
    (!media.frames.length ||
      !Number.isFinite(media.durationSeconds) ||
      media.durationSeconds <= 0)
  )
    throw new Error(
      "Image sequences require at least one frame and a positive window duration",
    );

  const hasAudio =
    media.kind === "audio" ||
    (isImages ? media.audio !== undefined : media.hasAudio);
  const hasSpeech = hasAudio && media.hasSpeech;
  const candidates = isVisual ? (identity?.candidates ?? []) : [];
  const hasIdentity = candidates.length > 0;
  const hasPets = isVisual && Boolean(pets?.length);
  const matchDisabled = identity?.matchDisabled === true;
  const fields = fieldOrder.filter((field) => {
    switch (field) {
      case "identities":
        return hasIdentity;
      case "pet_identities":
        return hasPets;
      case "caption":
      case "matched_rules":
        return isVisual;
      case "speeches":
        return hasSpeech;
      case "env_sounds":
        return hasAudio;
      case "suggestions":
        return true;
    }
  });
  const sectionKeys = [
    isVisual ? "role_video" : "role_audio",
    "output_mode",
    !isVisual
      ? "principle_audio"
      : !hasAudio
        ? "principle_no_audio"
        : !hasSpeech
          ? "principle_no_speech"
          : "principle_video",
    "tasks_header",
  ];
  const systemVariables: Record<string, string> = {
    media_description: !isVisual ? "音频" : hasAudio ? "视频和音频" : "视频",
    media_description_list: !isVisual
      ? "音频"
      : hasAudio
        ? "视频、音频"
        : "视频",
  };
  let taskNumber = 0;

  function task(key: string, numberKey: string) {
    sectionKeys.push(key);
    systemVariables[numberKey] = String(++taskNumber);
  }

  if (hasIdentity)
    task(
      matchDisabled ? "task_identity_no_match" : "task_identity",
      "identity_task_number",
    );
  if (isVisual) task("task_video", "video_task_number");
  if (hasAudio)
    task(hasSpeech ? "task_audio" : "task_no_speech", "audio_task_number");
  if (isVisual) task("task_rules", "rules_task_number");
  task("task_suggestions", "suggestions_task_number");

  function fieldKey(field: (typeof fieldOrder)[number]) {
    return field === "identities"
      ? matchDisabled
        ? "identity_no_match"
        : "identity"
      : field;
  }

  sectionKeys.push(
    "schema_open",
    ...fields.map((field) => `schema_${fieldKey(field)}`),
    "schema_close",
    "fields_header",
    ...fields.map(
      (field) =>
        `field_${fieldKey(field)}${!isVisual && (field === "speeches" || field === "suggestions") ? "_audio" : ""}`,
    ),
  );
  if (hasPets) sectionKeys.push("pet_naming");
  sectionKeys.push(isVisual ? "commonsense_video" : "commonsense_audio");
  if (isVisual && hasAudio) {
    sectionKeys.push("examples_header");
    if (hasIdentity && hasSpeech && !matchDisabled)
      sectionKeys.push("example_identity");
    sectionKeys.push(matchDisabled ? "example_chain_no_name" : "example_chain");
  }

  const cameraNote = context?.cameraPrompt?.trim();
  if (cameraNote) {
    sectionKeys.push("camera_note");
    systemVariables.camera_note = cameraNote;
  }

  function adaptVisualText(value: string) {
    if (!isImages) return value;

    const replacements = [
      ["视频**最后一帧**", "**最后一张主画面图片**"],
      ["本轮的视频和音频", "本轮按时间排列的画面图片和音频"],
      ["本轮的视频 / 音频", "本轮按时间排列的画面图片 / 音频"],
      ["本轮视频与音频", "本轮按时间排列的画面图片与音频"],
      ["本轮的视频", "本轮按时间排列的画面图片"],
      ["本轮视频", "本轮按时间排列的画面图片"],
      ["无视频画面", "无主画面图片"],
      ["视频画面", "主画面图片"],
      ["视频与音频", "画面图片与音频"],
      ["视频和音频", "画面图片和音频"],
      ["视频 / 音频", "画面图片 / 音频"],
      ["视频", "按时间排列的画面图片"],
    ] as const;
    return replacements.reduce(
      (valueSoFar, [source, target]) => valueSoFar.replaceAll(source, target),
      value,
    );
  }

  function buildSystemPrompt(
    binding: Parameters<typeof compileConversationInput>[0],
  ) {
    return binding.sections
      .map(({ key, tag, text: sectionText }) => {
        const content =
          key === "camera_note" ? sectionText : adaptVisualText(sectionText);
        return tag ? `<${key}>\n${content}\n</${key}>` : content;
      })
      .join("\n\n");
  }

  function buildMessages(
    binding: Parameters<typeof compileConversationInput>[0],
  ) {
    function compile(
      template: keyof typeof userTemplates,
      content: Array<TextContent | ImageContent>,
      variables: Parameters<typeof compileConversationInput>[2] = {},
    ) {
      const inputTemplate = binding.inputMessages[userTemplates[template]];
      if (!inputTemplate)
        throw new Error(`Missing perception prompt template: ${template}`);

      return compileConversationInput(
        {
          ...binding,
          inputMessages: [
            {
              ...inputTemplate,
              content: adaptVisualText(inputTemplate.content),
            },
          ],
        },
        content,
        variables,
      );
    }

    const messages = [];
    if (context?.homeProfile)
      messages.push(user(compile("profile", [text(context.homeProfile)])));
    if (isVisual && context?.rules?.length) {
      const rules = context.rules
        .toSorted((left, right) => left.id.localeCompare(right.id))
        .map((rule) => `- ${rule.name}：${rule.query}`)
        .join("\n");
      messages.push(user(compile("rules", [text(rules)])));
    }
    if (context?.pendingSpeech?.length) {
      const lastSpeech = context.pendingSpeech
        .map((speech) => speech.content)
        .join("；");
      messages.push(
        user(
          compile("history", [text(lastSpeech)], { last_speech: lastSpeech }),
        ),
      );
    }

    const content: Array<TextContent | ImageContent> = [];
    if (context?.currentTime)
      content.push(text(`当前时间: ${context.currentTime}`));
    if (context?.roomName) content.push(text(`位置: ${context.roomName}`));

    if (isVisual) {
      const candidateIds = new Set(
        candidates.map((candidate) => candidate.trackId),
      );
      const roster = (identity?.roster ?? []).filter(
        (person) =>
          !candidateIds.has(person.trackId) && !person.suppressAsPrior,
      );
      const renderPerson = (person: (typeof roster)[number]) =>
        `${person.label}${person.bbox ? `[bbox=(${person.bbox.join(", ")})]` : ""}`;
      const members = roster.filter((person) => person.kind === "member");
      const strangers = roster.filter((person) => person.kind === "stranger");
      content.push(
        text(
          `已识别人物：${members.length ? members.map(renderPerson).join(", ") : "无"}`,
        ),
      );
      if (strangers.length)
        content.push(text(`陌生人：${strangers.map(renderPerson).join(", ")}`));
      if (hasIdentity) {
        content.push(text("待识别 track："));
        for (const candidate of candidates) {
          const parts = [`  - track_id=${candidate.trackId}`];
          if (candidate.bbox) parts.push(`bbox=(${candidate.bbox.join(", ")})`);
          if (candidate.faceVisible !== undefined)
            parts.push(`face_visible=${candidate.faceVisible}`);
          content.push(text(parts.join(", ")));
        }
      }

      const hasBbox = roster.some((person) => person.bbox) || hasIdentity;
      if (hasBbox) content.push(...compile("bbox", []));
      if (hasIdentity && !matchDisabled) {
        if (identity?.gallery?.length) {
          content.push(...compile("gallery", []));
          for (const person of identity.gallery.slice(0, 10)) {
            content.push(text(`【${person.label}】`));
            content.push(...compile("body", [person.body]));
            if (person.face) content.push(...compile("face", [person.face]));
          }
          content.push(...compile("galleryEnd", []));

          const personCrops = candidates.filter((candidate) => candidate.image);
          if (personCrops.length) {
            content.push(...compile("personCrops", []));
            for (const candidate of personCrops)
              if (candidate.image)
                content.push(
                  ...compile("personCrop", [candidate.image], {
                    track_id: String(candidate.trackId),
                  }),
                );
          }
        } else {
          content.push(...compile("galleryEmpty", []));
        }
      }

      const petImages = pets?.filter((pet) => pet.image).slice(0, 3) ?? [];
      if (petImages.length) {
        content.push(...compile("pets", []));
        for (const pet of petImages) {
          content.push(
            text(`【${pet.name}】${pet.species ? `（${pet.species}）` : ""}`),
          );
          if (pet.image) content.push(pet.image);
        }
        content.push(...compile("petsEnd", []));
      }
      if (panorama)
        content.push(
          ...compile(hasBbox ? "panoramaBbox" : "panorama", [panorama]),
        );
    }

    const main = compile("main", content);
    if (media.kind === "images") {
      const cadence =
        media.frames.length === 1
          ? "仅一张图片"
          : `窗口时长约 ${media.durationSeconds} 秒、采样率约 ${Number((media.frames.length / media.durationSeconds).toFixed(2))} fps`;
      main.push(
        ...compile("imageSequence", media.frames, {
          frame_count: String(media.frames.length),
          cadence,
        }),
      );
      messages.push(
        user(
          media.audio === undefined
            ? main
            : [
                ...main,
                {
                  type: "media",
                  media: {
                    kind: "audio",
                    data: media.audio,
                    hasSpeech: media.hasSpeech,
                  },
                },
              ],
        ),
      );
    } else {
      messages.push(user([...main, { type: "media", media }]));
    }
    return messages;
  }

  return { sectionKeys, systemVariables, buildSystemPrompt, buildMessages };
}
