// Auth protocol types shared with the external E2EE sync server, plus image
// filename detection. The deterministic note rules (filename/title + tags)
// moved to `@futo-notes/editor` in migration Phase 3 — import those from
// `@futo-notes/editor` (or `$lib/rules` in the app), not here.
export type {
  SetupRequest,
  LoginRequest,
  LoginResponse,
  RevokeRequest,
  RevokeResponse,
  HealthResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
  ErrorResponse,
} from './sync.js';
export { IMAGE_EXTENSIONS, isImageFilename } from './sync.js';
