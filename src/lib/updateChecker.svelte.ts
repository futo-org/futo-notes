/**
 * Reactive desktop self-update coordinator — single source of truth for the
 * updater UI.
 *
 * Wraps the stateless helpers in `./updater` with a small reactive state
 * machine so both surfaces share one definition of "is there an update":
 *   - the global {@link UpdateBanner} (auto-check on launch + hourly), and
 *   - the manual "Check for updates" button in Settings.
 *
 * Having one machine means a manual check clears the banner, an auto-check
 * populates Settings, and the two can never show conflicting versions.
 *
 * Desktop-only: `start()` no-ops where the running install can't self-update
 * (mobile/web, or a deb/rpm install that updates via the system package repo).
 */
import {
  checkForUpdate,
  installUpdate,
  relaunchApp,
  selfUpdateSupported,
  updaterSupported,
  type PendingUpdate,
} from './updater';
import { loadPreferences } from './appState';

/** Re-check interval for the hourly background poll. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Per-request timeout so a dead endpoint can't wedge a check. */
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

  /** True once the user kicks off an install, so a resulting error can offer a
   *  retry in the banner — without a silent background-check error ever popping
   *  one. See `bannerVisible`. */
  #engaged = $state(false);
  /** False after disable(); a silent check already in flight when the user
   *  turned updates off must discard its result — with the poll stopped,
   *  nothing would ever retract the banner it raised. */
  #enabled = true;
  /** Guards overlapping background polls (so a slow check doesn't stack). */
  #silentInFlight = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #started = false;
  /** Bumped by each start(); lets a start() detect that a stop()+start() pair
   *  superseded it while its async support gate was awaiting (so it won't create
   *  an interval the latest start() — and thus stop() — can't track/cancel). */
  #startGen = 0;

  /** A check/download/install is in flight — disables the action buttons. */
  get busy(): boolean {
    return this.phase === 'checking' || this.phase === 'downloading' || this.phase === 'installing';
  }

  /** Download progress as 0–100, or null when the total is unknown. */
  get percent(): number | null {
    return this.total && this.total > 0
      ? Math.min(100, Math.round((this.received / this.total) * 100))
      : null;
  }

  /** Whether the floating banner should be shown right now. */
  get bannerVisible(): boolean {
    switch (this.phase) {
      // 'error' shows only after the user engaged an install from the banner (so
      // it can offer a retry) — never for a silent background-check error.
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

  /**
   * Begin background checks: one immediately, then every hour. Idempotent and
   * desktop-only; no-ops where the running install can't self-update — which
   * includes dev (`cargo`-run, not an AppImage) so a dev build never auto-polls
   * the production endpoint. Devs exercise the flow via the Settings → Updates
   * button (force-shown in dev) and the UpdateBanner component test.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    // Claim the started flag synchronously, BEFORE the async selfUpdateSupported()
    // gate — otherwise two concurrent start()s both pass the guard and each leak
    // an interval, and a stop() during the await can't cancel the timer this call
    // creates afterward. Reset it if we end up not starting.
    this.#started = true;
    this.#enabled = true;
    const gen = ++this.#startGen;

    if (!updaterSupported() || !(await selfUpdateSupported())) {
      // Only un-claim if no stop()+start() pair superseded us during the await
      // (else we'd clear the flag the newer start() legitimately holds).
      if (this.#startGen === gen) this.#started = false;
      return;
    }
    // Respect the user's "automatically check for updates" pref: a disabled
    // install runs no background poll (Settings also hides the manual check).
    if (!(await loadPreferences()).updates.enabled) {
      if (this.#startGen === gen) this.#started = false;
      return;
    }
    // stop() (→ #started=false) OR a newer start() (→ bumped #startGen) may have
    // run during the await above (teardown / HMR). Either means this call is
    // stale: abort rather than create an orphaned interval. Checking #started
    // alone misses the stop()+start() case — the latest start() re-set it true,
    // but #timer now belongs to that call, so ours would leak unreferenced.
    if (!this.#started || this.#startGen !== gen) return;
    void this.check({ silent: true });
    this.#timer = setInterval(() => {
      void this.check({ silent: true });
    }, CHECK_INTERVAL_MS);
  }

  /** Stop the hourly poll (called on app teardown / HMR re-init). */
  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#started = false;
  }

  /**
   * User disabled updates in Settings: stop the poll and clear any not-yet-
   * installed update so the banner and Settings action disappear. Only reachable
   * when idle — the toggle locks during download/install/restart, which stage
   * bytes on disk that can't be un-done. A later re-enable calls start() again.
   */
  disable(): void {
    this.stop();
    this.pending = null;
    this.phase = 'idle';
    this.error = '';
    this.#engaged = false;
    this.#enabled = false;
  }

  /**
   * Query the endpoint and update the state machine.
   *
   * A `silent` (background/auto) check is **invisible**: it never sets the
   * `checking` / `error` / `up-to-date` phases, so a slow or dead endpoint can
   * never wedge the Settings button or nag the user. It only raises the banner
   * by flipping to `available` on success — and never disturbs a manual check
   * or an in-progress install. A manual check (`silent: false`, the default)
   * drives the visible `checking → available/up-to-date/error` flow.
   */
  async check(opts: { silent?: boolean } = {}): Promise<void> {
    const silent = opts.silent ?? false;

    if (silent) {
      if (this.#silentInFlight) return;
      this.#silentInFlight = true;
      try {
        const update = await checkForUpdate(CHECK_TIMEOUT_MS);
        // Never disturb a manual check (busy ⊇ 'checking'), an install in
        // progress, or a staged update awaiting restart. #enabled: discard a
        // result that was in flight when the user disabled updates.
        if (this.#enabled && !this.busy && this.phase !== 'restart') {
          if (update) {
            // Preserve the engaged-error retry banner for the SAME failed
            // version, but let a NEWER version override 'error' — a transient
            // install failure must never permanently suppress future updates
            // (this hourly poll is the only background path that surfaces them).
            const sameFailedVersion =
              this.phase === 'error' && this.pending?.version === update.version;
            if (!sameFailedVersion) {
              this.pending = update;
              this.phase = 'available';
            }
          } else if (this.phase === 'available') {
            // The previously-offered release is gone (e.g. yanked) — retract the
            // banner so we never advertise a version the endpoint no longer serves.
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

  /**
   * Download + verify + install the pending update, then relaunch. On success
   * the relaunch terminates the process so this never returns; a failure leaves
   * `pending` set so the UI can offer a retry.
   */
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
        // Advance to 'installing' once the download finishes even when the
        // content length was unknown (total stays null → the check above never trips).
        () => {
          this.phase = 'installing';
        },
      );
      // installUpdate() relaunches on success, so we normally never get here.
      // If the relaunch resolved without killing the process, finish the job
      // automatically — relaunch from here rather than parking on a manual
      // "Restart now". (In dev fake mode relaunchApp() no-ops, so the UI rests
      // on 'restart'/"Restarting…", the simulated end state.)
      this.phase = 'restart';
      await this.restart();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.phase = 'error';
    }
  }

  /** Finish a staged update by relaunching (only used if auto-relaunch didn't fire). */
  async restart(): Promise<void> {
    try {
      await relaunchApp();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.phase = 'error';
    }
  }
}

/** App-wide singleton. */
export const updateChecker = new UpdateChecker();
