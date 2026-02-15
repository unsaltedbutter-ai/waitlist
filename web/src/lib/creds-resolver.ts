/**
 * Resolves which credentials to use for a given service group.
 * When "use same credentials" is on, shared creds override per-service creds.
 */
export function getCredsForGroup(
  groupId: string,
  useSameCreds: boolean,
  sharedCreds: { email: string; password: string },
  perServiceCreds: Record<string, { email: string; password: string }>
): { email: string; password: string } {
  if (useSameCreds) return sharedCreds;
  return perServiceCreds[groupId] ?? { email: "", password: "" };
}
