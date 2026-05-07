/**
 * Client-side E2EE crypto using Web Crypto API.
 *
 * Encryption: AES-256-GCM with random 12-byte IV per blob.
 * Key derivation: PBKDF2 (100k iterations, SHA-256) from password + salt.
 * Vault key: random AES-256-GCM key, wrapped by the password-derived key.
 * Note packing: binary format [4-byte filename length][filename UTF-8][content UTF-8].
 */

export const PBKDF2_ITERATIONS = 100_000;
const IV_BYTES = 12;
const SALT_BYTES = 16;

// ── Key derivation ───────────────────────────────────────────────────────

export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function exportKeyBytes(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}

export async function importVaultKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    raw as BufferSource,
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt'],
  );
}

// ── Encrypt / Decrypt ────────────────────────────────────────────────────

/** Encrypt plaintext. Returns `[12-byte IV || ciphertext+tag]`. */
export async function encrypt(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext as BufferSource);
  const result = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_BYTES);
  return result;
}

/** Decrypt data produced by `encrypt()`. */
export async function decrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.slice(0, IV_BYTES);
  const ciphertext = data.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext as BufferSource);
  return new Uint8Array(plaintext);
}

// ── Note blob packing ────────────────────────────────────────────────────

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * V2 frame: `[1-byte version=2][4-byte path length BE][path UTF-8][content UTF-8]`.
 *
 * V1 frame (pre-folder support): `[4-byte filename length BE][filename UTF-8][content UTF-8]`.
 *
 * V1 and V2 are distinguished by the first byte: real filenames/paths fit
 * comfortably under 16 MB, so the high byte of a V1 length prefix is
 * always 0x00. V2 uses 0x02 as its version byte. Anything else is
 * rejected as an unknown frame version.
 */
export const NOTE_FRAME_V2 = 0x02;

/** Pack a note (relative path + content) into a single binary blob for
 *  encryption. `path` is the relative path INCLUDING the `.md` extension,
 *  e.g. `Specs/folder-support.md`. Use `${id}.md` to convert from a note ID. */
export function packNote(path: string, content: string): Uint8Array {
  const pathBytes = textEncoder.encode(path);
  const contentBytes = textEncoder.encode(content);
  const result = new Uint8Array(1 + 4 + pathBytes.byteLength + contentBytes.byteLength);
  result[0] = NOTE_FRAME_V2;
  const view = new DataView(result.buffer);
  view.setUint32(1, pathBytes.byteLength, false);
  result.set(pathBytes, 5);
  result.set(contentBytes, 5 + pathBytes.byteLength);
  return result;
}

/** Pack a note using the legacy V1 frame. Test-only — production callers
 *  should always use `packNote` (V2). */
export function packNoteV1(filename: string, content: string): Uint8Array {
  const filenameBytes = textEncoder.encode(filename);
  const contentBytes = textEncoder.encode(content);
  const result = new Uint8Array(4 + filenameBytes.byteLength + contentBytes.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, filenameBytes.byteLength, false);
  result.set(filenameBytes, 4);
  result.set(contentBytes, 4 + filenameBytes.byteLength);
  return result;
}

/** Unpack a note blob. Returns `{ filename, content }` where `filename`
 *  is the relative path with `.md`. Auto-detects V1 vs V2 by first byte. */
export function unpackNote(data: Uint8Array): { filename: string; content: string } {
  if (data.length === 0) {
    throw new Error('empty note blob');
  }
  const versionByte = data[0];
  if (versionByte === NOTE_FRAME_V2) {
    if (data.length < 5) {
      throw new Error('truncated v2 note blob');
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const pathLen = view.getUint32(1, false);
    if (5 + pathLen > data.length) {
      throw new Error('v2 note blob path length out of bounds');
    }
    const filename = textDecoder.decode(data.slice(5, 5 + pathLen));
    const content = textDecoder.decode(data.slice(5 + pathLen));
    return { filename, content };
  }
  // V1 fallback: first byte is high byte of a 4-byte BE length. For
  // realistic filenames (< 16 MB) this is always 0x00.
  if (versionByte !== 0x00) {
    throw new Error(`unknown note frame version: ${versionByte}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const filenameLen = view.getUint32(0, false);
  if (4 + filenameLen > data.length) {
    throw new Error('v1 note blob filename length out of bounds');
  }
  const filename = textDecoder.decode(data.slice(4, 4 + filenameLen));
  const content = textDecoder.decode(data.slice(4 + filenameLen));
  return { filename, content };
}

// ── Hex helpers ──────────────────────────────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
