/**
 * The passkey nudge's dismissal, kept on this device (passkey-unlock spec §3).
 * Storage may be refused (private browsing): every access is best effort.
 */
const NUDGE_DISMISSED_KEY = 'docscanner.passkeyNudgeDismissed';

export function nudgeDismissed(): boolean {
  try {
    return localStorage.getItem(NUDGE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function storeNudgeDismissal(): void {
  try {
    localStorage.setItem(NUDGE_DISMISSED_KEY, '1');
  } catch {
    // Refused: dismissed until the next visit.
  }
}

/** No passkey is left: the nudge may show again after the next login. */
export function clearNudgeDismissal(): void {
  try {
    localStorage.removeItem(NUDGE_DISMISSED_KEY);
  } catch {
    // Refused: nothing was stored either.
  }
}
