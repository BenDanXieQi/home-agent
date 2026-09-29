// One allocator per source run, shared by human and pet trajectories. Clearing
// tracking state after a frame-size change never reuses an earlier identifier.
export function createTrackIds() {
  let next = 1;
  return () => next++;
}
