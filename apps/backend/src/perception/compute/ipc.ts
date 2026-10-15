export function sendProcessMessage(
  value: object,
  requestId: string | null = null,
) {
  return new Promise<void>((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("Inference IPC disconnected"));
      return;
    }
    process.send({ requestId, message: value }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
