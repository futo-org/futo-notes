// remote-test.mjs command line: flags and the --help text.
import {
  DEFAULT_HOST,
  DEFAULT_REMOTE_DIR,
  DEFAULT_SOURCE_REPO,
  DEFAULT_USER,
  EXIT_LOCKED,
  EXIT_MOVED,
  EXIT_REFUSED,
  FALLBACK_HOSTS,
} from './settings.mjs';

export function parseCliArgs(argv) {
  const opts = {
    doctor: false,
    mode: 'git',
    host: process.env.FUTO_REMOTE_HOST || null,
    user: process.env.FUTO_REMOTE_USER || DEFAULT_USER,
    remoteDir: process.env.FUTO_REMOTE_DIR || DEFAULT_REMOTE_DIR,
    sourceRepo: process.env.FUTO_REMOTE_REPO || DEFAULT_SOURCE_REPO,
    forceLock: false,
    waitSeconds: 0,
    help: false,
    recipe: null,
    recipeArgs: [],
    androidEnv: {},
  };

  let i = 0;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      i += 1;
      break;
    }
    if (!arg.startsWith('-')) break;
    switch (arg) {
      case '--doctor':
      case '--setup':
        opts.doctor = true;
        break;
      case '--rsync':
        opts.mode = 'rsync';
        break;
      case '--force-lock':
        opts.forceLock = true;
        break;
      case '--kill':
        opts.kill = true;
        break;
      case '--wait': {
        // Accept `--wait 600` as well as `--wait=600`. Only consume the next
        // argument when it actually looks like a duration: bare `--wait` is
        // valid and is normally followed by the recipe name, which must not be
        // swallowed. Before this, `--wait 600 <recipe>` ate the recipe slot with
        // "600" and died with an unhelpful is-not-a-recipe error
        // (pc_8082388d5c53).
        const next = argv[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          opts.waitSeconds = Number(next);
          i += 1;
        } else {
          opts.waitSeconds = 1800;
        }
        break;
      }
      case '--android-env': {
        const [key, ...parts] = (argv[++i] ?? '').split('=');
        const value = parts.join('=');
        const patterns = {
          ABIS: /^(?:arm64-v8a|armeabi-v7a|x86_64|x86)(?:,(?:arm64-v8a|armeabi-v7a|x86_64|x86))*$/,
          FUTO_ANDROID_FFI_PROFILE: /^release-ffi$/,
          GRADLE_OPTS:
            /^-Dorg\.gradle\.project\.android\.testInstrumentationRunnerArguments\.editorRequire32Bit=true$/,
          ANDROID_SERIAL: /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/,
          ANDROID_AVD_NAME: /^(?:futo-qa-\d+|futo-api(?:28|29|30))$/,
        };
        if (!Object.hasOwn(patterns, key) || !patterns[key].test(value))
          throw new Error(
            '--android-env requires a valid ABIS, FUTO_ANDROID_FFI_PROFILE, ANDROID_SERIAL, ANDROID_AVD_NAME or fixed editorRequire32Bit GRADLE_OPTS setting',
          );
        if (Object.hasOwn(opts.androidEnv, key)) throw new Error(`duplicate --android-env ${key}`);
        opts.androidEnv[key] = value;
        break;
      }
      case '--host':
        opts.host = argv[++i];
        break;
      case '--user':
        opts.user = argv[++i];
        break;
      case '--dir':
        opts.remoteDir = argv[++i];
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default: {
        // --wait=600 / --host=box, alongside the space-separated forms.
        const eq = arg.indexOf('=');
        if (eq > 0) {
          const [flag, value] = [arg.slice(0, eq), arg.slice(eq + 1)];
          if (flag === '--wait') {
            const seconds = Number(value);
            if (!Number.isInteger(seconds) || seconds < 0) {
              throw new Error(`--wait takes a whole number of seconds, got '${value}'`);
            }
            opts.waitSeconds = seconds;
            break;
          }
          if (flag === '--host') {
            opts.host = value;
            break;
          }
          if (flag === '--user') {
            opts.user = value;
            break;
          }
          if (flag === '--dir') {
            opts.remoteDir = value;
            break;
          }
        }
        throw new Error(
          `unknown option '${arg}'. Options must come BEFORE the recipe name; ` +
            `everything after it is passed to \`just\`.`,
        );
      }
    }
  }
  if (i < argv.length) {
    opts.recipe = argv[i];
    opts.recipeArgs = argv.slice(i + 1);
  }
  return opts;
}

export const HELP = `remote-test — run this repo's non-macOS suites on a Linux box over Tailscale

  node scripts/remote-test.mjs [options] <just-recipe> [recipe args...]
  node scripts/remote-test.mjs --doctor

Options (must precede the recipe name):
  --rsync            push the working tree as-is instead of checking out a pushed sha
  --kill             reap THIS worktree's remote run (its process group only) and
                     release the lock — never a pattern kill, so a sibling agent's
                     processes on the shared box are untouched
  --doctor, --setup  report what is present/missing on the remote and exit
  --host H           default $FUTO_REMOTE_HOST or '${DEFAULT_HOST}' (falls back to ${FALLBACK_HOSTS[0]})
  --user U           default $FUTO_REMOTE_USER or '${DEFAULT_USER}'
  --dir PATH         remote worktree, default $FUTO_REMOTE_DIR or '${DEFAULT_REMOTE_DIR}'
  --wait[=SECONDS]   queue behind a run in progress instead of failing (default 1800s)
  --android-env K=V  pass an explicit ABIS, release-ffi profile, claimed serial or QA AVD
                     to the recipe; fixed GRADLE_OPTS editorRequire32Bit assertion also supported
                     (repeatable; no general shell/environment overrides)
  --force-lock       break a stale remote worktree lock

Exit status is the remote command's own. ${EXIT_REFUSED} = refused before running,
${EXIT_LOCKED} = the remote worktree was locked by another run, ${EXIT_MOVED} = the remote
checkout moved mid-run, so the result is void rather than a real failure.

FUTO_REMOTE_LOCAL_ROOT selects an existing local source worktree; defaults to the tool checkout.
Normal recipe source metadata and Git identity use that selected tree; doctor helper
versions still come from the transport checkout.

The remote worktree is the runner's OWN working area. Do not cd into it and run
suites by hand: that bypasses the lock and produces phantom failures.

Run it directly: \`node scripts/remote-test.mjs <recipe>\` (or \`--doctor\`). \`just remote-sync\`
is the one wrapper kept as a \`just\` recipe. Boundaries and caveats: docs/remote-testing.md.
`;
