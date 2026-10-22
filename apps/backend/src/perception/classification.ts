export function updateClassification<T>(
  current: T,
  observed: T,
  opposingSamples: number,
) {
  const next = current === observed ? 0 : opposingSamples + 1;
  return next >= 3
    ? { value: observed, opposingSamples: 0 }
    : { value: current, opposingSamples: next };
}
