export const MIN_AGENT_DEVICE_VERSION = "0.21.25";
export const AGENT_DEVICE_RPC_PROTOCOL_VERSION = 2;
export const MIN_NODE_VERSION = "22.12.0";

function numbersOf(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isVersionAtLeast(version: string, minimum: string): boolean {
  const found = numbersOf(version);
  const needed = numbersOf(minimum);
  if (found === undefined || needed === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (found[index] ?? 0) - (needed[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
