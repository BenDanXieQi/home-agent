// Model context belongs to sound analysis, independently of capture windows.
export const petSoundPolicy = Object.freeze({
  sampleRate: 16000,
  contextMs: 4000,
  hopMs: 2000,
  initializeTimeoutMs: 30000,
  inferenceTimeoutMs: 2000,
  closeTimeoutMs: 3000,
  queueAgeMs: 3000,
  resultAgeMs: 15000,
  maxFailures: 3,
  recoveryDelayMs: 1000,
});

export function petSoundDeliveryDeadline(
  endedAt: number,
  maxFrameAgeMs: number,
) {
  return (
    endedAt +
    petSoundPolicy.initializeTimeoutMs +
    petSoundPolicy.queueAgeMs +
    petSoundPolicy.inferenceTimeoutMs +
    maxFrameAgeMs
  );
}
