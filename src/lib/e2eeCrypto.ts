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

/** Pack a note (filename + content) into a single binary blob for encryption. */
export function packNote(filename: string, content: string): Uint8Array {
  const filenameBytes = textEncoder.encode(filename);
  const contentBytes = textEncoder.encode(content);
  const result = new Uint8Array(4 + filenameBytes.byteLength + contentBytes.byteLength);
  // 4-byte big-endian filename length
  const view = new DataView(result.buffer);
  view.setUint32(0, filenameBytes.byteLength, false);
  result.set(filenameBytes, 4);
  result.set(contentBytes, 4 + filenameBytes.byteLength);
  return result;
}

/** Unpack a note blob produced by `packNote()`. */
export function unpackNote(data: Uint8Array): { filename: string; content: string } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const filenameLen = view.getUint32(0, false);
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
