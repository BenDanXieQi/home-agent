function capabilityAddress(key: string, kind: "prop" | "action") {
  const match = /^(prop|action)\.([1-9]\d*)\.([1-9]\d*)$/.exec(key);
  if (!match || match[1] !== kind) return null;
  const service = Number(match[2]);
  const instance = Number(match[3]);
  if (!Number.isSafeInteger(service) || !Number.isSafeInteger(instance))
    return null;
  return { service, instance };
}

export function mijiaPropertyAddress(key: string) {
  const address = capabilityAddress(key, "prop");
  return address ? { siid: address.service, piid: address.instance } : null;
}

export function mijiaActionAddress(key: string) {
  const address = capabilityAddress(key, "action");
  return address ? { siid: address.service, aiid: address.instance } : null;
}
