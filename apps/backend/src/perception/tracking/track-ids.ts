export function createTrackIds() {
  let next = 1;
  return () => next++;
}
