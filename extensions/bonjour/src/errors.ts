export function formatBonjourError(err: unknown): string {
  if (err instanceof Error) {
    const trimmedMessage = err.message.trim();
    const msg = trimmedMessage || err.name || String(err).trim();
    if (err.name && err.name !== "Error") {
      return msg === err.name ? err.name : `${err.name}: ${msg}`;
    }
    return msg;
  }
  return String(err);
}

const BONJOUR_SERVER_CLOSED_MESSAGE_RE =
  /\bERR_SERVER_CLOSED\b|cannot send packets on a closed mdns server!?/iu;

export function isBonjourServerClosedError(err: unknown): boolean {
  return BONJOUR_SERVER_CLOSED_MESSAGE_RE.test(formatBonjourError(err));
}
