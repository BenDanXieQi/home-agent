// AudioSet labels with an explicit domestic species meaning. Shared labels
// such as Growling, Hiss and Howl cannot establish which animal made a sound.
const speciesLabels = {
  dog: new Set(["Dog", "Bark", "Yip", "Bow-wow", "Whimper (dog)"]),
  cat: new Set(["Cat", "Purr", "Meow", "Caterwaul"]),
};

export function selectPetSounds(
  events: readonly { label: string; score: number }[],
  threshold: number,
) {
  return (["dog", "cat"] as const).flatMap((kind) => {
    let strongest: (typeof events)[number] | undefined;
    for (const event of events) {
      if (
        speciesLabels[kind].has(event.label) &&
        Number.isFinite(event.score) &&
        event.score <= 1 &&
        event.score >= threshold &&
        (!strongest || event.score > strongest.score)
      )
        strongest = event;
    }
    return strongest
      ? [{ kind, score: strongest.score, label: strongest.label }]
      : [];
  });
}
