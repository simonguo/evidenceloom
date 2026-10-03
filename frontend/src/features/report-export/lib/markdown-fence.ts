/** Select a fence without spreading untrusted match counts into function args. */
export function fencedJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  let length = 3;
  for (const match of json.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}json\n${json}\n${fence}`;
}
