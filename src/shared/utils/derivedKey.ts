/**
 * Pure helper that derives a storage-backend userId from a raw CEK.
 *
 * Uses PBKDF2-SHA256 with 600k iterations over the salt
 * `gremlinofa-userid-v1` and outputs 256 bits as a 64-character hex
 * string. The same function lives on `encryptionService.deriveUserId`
 * for the backend; this version takes the bytes directly so the OOBE
 * flow can call it on the main thread before `gremlinClient.init` runs.
 */
export async function deriveUserIdFromCEK(cekBytes: Uint8Array): Promise<string> {
  const salt = new TextEncoder().encode('gremlinofa-userid-v1');
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(cekBytes),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 600000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  const bytes = new Uint8Array(derivedBits);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
