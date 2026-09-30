/**
 * Alert text for a loop that didn't start (the `startLoop` RPC rejected).
 * The backend's typed codes get a sentence a user can act on; anything else
 * (a dropped socket, a model that no longer exists) shows its own message.
 */
export function describeLoopStartError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'CHAT_BUSY') {
    return 'This chat already has a reply running. Wait for it to finish (or stop it), then try again.';
  }
  if (code === 'CHAT_INCOMPLETE_TAIL') {
    return 'The last assistant message was aborted. Resolve it (delete the message or roll back) before continuing.';
  }
  return err instanceof Error ? err.message : String(err);
}
