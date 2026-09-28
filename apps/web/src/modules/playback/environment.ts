function networkConnection() {
  return "connection" in navigator &&
    navigator.connection instanceof EventTarget
    ? navigator.connection
    : null;
}

/** A coarse comparison hint, never a network identity. */
export function readPlaybackEnvironment() {
  const connection = networkConnection();
  if (!connection) return null;
  const values = [
    "type" in connection && typeof connection.type === "string"
      ? connection.type
      : null,
    "effectiveType" in connection &&
    typeof connection.effectiveType === "string"
      ? connection.effectiveType
      : null,
  ];
  return values.every((value) => value === null)
    ? null
    : JSON.stringify(values);
}

/** Observes connectivity changes; the history owner controls the subscription. */
export function observePlaybackEnvironment(onChange: () => void) {
  const connection = networkConnection();
  let observedClass = readPlaybackEnvironment();
  const connectivityChanged = () => {
    observedClass = readPlaybackEnvironment();
    onChange();
  };
  const connectionClassChanged = () => {
    const nextClass = readPlaybackEnvironment();
    // RTT/downlink fluctuate during ordinary requests. Only a changed coarse
    // connection class signals a new environment for this observer.
    if (nextClass === observedClass) return;
    observedClass = nextClass;
    onChange();
  };
  window.addEventListener("online", connectivityChanged);
  window.addEventListener("offline", connectivityChanged);
  connection?.addEventListener("change", connectionClassChanged);
  return () => {
    window.removeEventListener("online", connectivityChanged);
    window.removeEventListener("offline", connectivityChanged);
    connection?.removeEventListener("change", connectionClassChanged);
  };
}
