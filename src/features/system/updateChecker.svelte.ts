import {
  checkForUpdate,
  installUpdate,
  relaunchApp,
  selfUpdateSupported,
  updaterSupported,
  type PendingUpdate,
} from './updater';
import { loadPreferences } from '$shared/state/appState';

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30 * 1000;

export type UpdPhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'restart'
  | 'error';

class UpdateChecker {
  phase = $state<UpdPhase>('idle');
  pending = $state<PendingUpdate | null>(null);
  received = $state(0);
  total = $state<number | null>(null);
  error = $state('');

  #engaged = $state(false);
  #enabled = true;
  #silentInFlight = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #started = false;
  #startGen = 0;

  get busy(): boolean {
    return this.phase === 'checking' || this.phase === 'downloading' || this.phase === 'installing';
  }

  get percent(): number | null {
    return this.total && this.total > 0
      ? Math.min(100, Math.round((this.received / this.total) * 100))
      : null;
  }

  get bannerVisible(): boolean {
    switch (this.phase) {
      case 'error':
        return this.#engaged && this.pending != null;
      case 'available':
      case 'restart':
      case 'downloading':
      case 'installing':
        return true;
      default:
        return false;
    }
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#enabled = true;
    const gen = ++this.#startGen;

    if (!updaterSupported() || !(await selfUpdateSupported())) {
      if (this.#startGen === gen) this.#started = false;
      return;
    }
    if (!(await loadPreferences()).updates.enabled) {
      if (this.#startGen === gen) this.#started = false;
      return;
    }
    if (!this.#started || this.#startGen !== gen) return;
    void this.check({ silent: true });
    this.#timer = setInterval(() => {
      void this.check({ silent: true });
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#started = false;
  }

  disable(): void {
    this.stop();
    this.pending = null;
    this.phase = 'idle';
    this.error = '';
    this.#engaged = false;
    this.#enabled = false;
  }

  async check(opts: { silent?: boolean } = {}): Promise<void> {
    const silent = opts.silent ?? false;

    if (silent) {
      if (this.#silentInFlight) return;
      this.#silentInFlight = true;
      try {
        const update = await checkForUpdate(CHECK_TIMEOUT_MS);
        if (this.#enabled && !this.busy && this.phase !== 'restart') {
          if (update) {
            const sameFailedVersion =
              this.phase === 'error' && this.pending?.version === update.version;
            if (!sameFailedVersion) {
              this.pending = update;
              this.phase = 'available';
            }
          } else if (this.phase === 'available') {
            this.pending = null;
            this.phase = 'idle';
          }
        }
      } catch (e) {
        console.warn('Background update check failed:', e);
      } finally {
        this.#silentInFlight = false;
      }
      return;
    }

    if (this.busy) return;
    this.phase = 'checking';
    this.error = '';
    try {
      const update = await checkForUpdate(CHECK_TIMEOUT_MS);
      if (update) {
        this.pending = update;
        this.phase = 'available';
      } else {
        this.pending = null;
        this.phase = 'up-to-date';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.phase = 'error';
    }
  }

  async install(): Promise<void> {
    if (!this.pending || this.busy) return;
    this.#engaged = true;
    this.phase = 'downloading';
    this.received = 0;
    this.total = null;
    this.error = '';
    try {
      await installUpdate(
        this.pending,
        (received, total) => {
          this.received = received;
          this.total = total;
          if (total != null && received >= total) this.phase = 'installing';
        },
        () => {
          this.phase = 'installing';
        },
      );
      this.phase = 'restart';
      await this.restart();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.phase = 'error';
    }
  }

  async restart(): Promise<void> {
    try {
      await relaunchApp();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.phase = 'error';
    }
  }
}

export const updateChecker = new UpdateChecker();
