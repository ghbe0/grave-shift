// Party codes and shareable links. A party is identified by a 6-character code that doubles as
// the host's PeerJS id, so joining needs no server of our own.

/** No 0/O/1/I/L, so codes survive being read aloud or typed from a screenshot. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const PARTY_PARAM = 'party';

export function generateCode(random: () => number = secureRandom): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return code;
}

function secureRandom(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
}

/** Cleans up user input ("abc-123 " -> "ABC123"). Returns null if it cannot be a party code. */
export function normalizeCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const code = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== CODE_LENGTH || [...code].some(c => !ALPHABET.includes(c))) return null;
  return code;
}

/** Reads `?party=CODE` from a URL (defaults to the page URL). */
export function codeFromUrl(href: string = location.href): string | null {
  return normalizeCode(new URL(href).searchParams.get(PARTY_PARAM));
}

/** The link friends open to join: the current page with `?party=CODE`. */
export function partyLink(code: string, href: string = location.href): string {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  url.searchParams.set(PARTY_PARAM, code);
  return url.toString();
}

/** Shows or clears the party code in the address bar without reloading. */
export function setUrlCode(code: string | null): void {
  const url = new URL(location.href);
  if (code) url.searchParams.set(PARTY_PARAM, code); else url.searchParams.delete(PARTY_PARAM);
  history.replaceState(null, '', url);
}

export const peerIdFor = (code: string) => `graveshift-v2-${code}`;
