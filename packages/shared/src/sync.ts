// ── Images ────────────────────────────────────────────

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'] as const;

/** Check whether a filename has an image extension (case-insensitive). */
export function isImageFilename(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = filename.slice(dot + 1).toLowerCase();
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

// ── Auth ───────────────────────────────────────────────

export interface SetupRequest {
  password: string;
}

export interface LoginRequest {
  password: string;
  device_info?: string;
}

export interface LoginResponse {
  token: string;
}

export interface RevokeRequest {
  mode: 'current' | 'all' | 'specific';
  /** Required when mode === 'specific'. */
  token_hashes?: string[];
}

export interface RevokeResponse {
  revoked: number;
}

// ── Health ─────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok';
  setup_complete: boolean;
}

// ── Change Password ───────────────────────────────────

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

export interface ChangePasswordResponse {
  success: boolean;
  token: string;
}

// ── Errors ─────────────────────────────────────────────

export interface ErrorResponse {
  error: string;
}
