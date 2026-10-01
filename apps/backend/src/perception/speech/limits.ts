export const speechLimits = Object.freeze({
  sampleRate: 16000,
  frameSamples: 512,
  maxSegmentSamples: 16 * 16000,
  maxTracks: 8,
  pendingJobs: 8,
  queueAgeMs: 3000,
  resultAgeMs: 15000,
  inferenceTimeoutMs: 2000,
  initializeTimeoutMs: 30000,
  closeTimeoutMs: 3000,
  recoveryDelayMs: 1000,
  maxFailures: 3,
  positiveThreshold: 0.4,
  negativeThreshold: 0.25,
  preSpeechPadMs: 192,
  minSpeechMs: 256,
  redemptionMs: 512,
});
export const senseVoiceModel = Object.freeze({
  sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
  tokensSha256:
    "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
  processingVersion: "sensevoice-silero-frame-processor" as const,
});
