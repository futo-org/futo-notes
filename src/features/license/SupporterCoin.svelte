<script lang="ts">
  import { localizedText } from '$shared/localization';

  import { buildCoin, type CoinHandle } from './supporterCoin';

  // The FUTO coin: a gold disc with the diamond punched through it, turning.
  // It is the one thing a purchase *adds* — everywhere else the reward is a
  // label going away (docs/spec/license.md § States and copy).
  //
  // It fills whatever box the caller gives it, so the layout owns the size.
  //
  // three.js is reached only through `import()` inside `supporterCoin.ts`, so
  // it stays off the cold-start path and is fetched the first time a licensed
  // user opens Settings. Nothing waits on it: until the module lands — and
  // permanently, if WebGL is unavailable or the import fails — the flat SVG
  // below is what renders, and it is a whole coin, not a placeholder box.
  interface Props {
    /// Bumped by the caller to spin the coin up once. It is the moment a key
    /// was accepted, not a state the coin sits in.
    celebrate?: number;
  }

  let { celebrate = 0 }: Props = $props();

  let host: HTMLDivElement | null = $state(null);
  let handle: CoinHandle | null = $state(null);

  $effect(() => {
    const mount = host;
    if (mount === null) return;

    let live: CoinHandle | null = null;
    let disposed = false;

    void buildCoin(mount)
      .then((built) => {
        // The effect can tear down while the dynamic import is still in
        // flight. Without this the canvas is appended to a detached node and
        // keeps its animation frame forever.
        if (disposed || built === null) {
          built?.dispose();
          return;
        }
        live = built;
        handle = built;
        // Motion is opt-out at the OS level, so ask before spinning anything.
        // A stopped coin still renders — it just holds still.
        built.setSpinning(!matchMedia('(prefers-reduced-motion: reduce)').matches);
      })
      .catch((error) => {
        // No WebGL context is not worth surfacing: the SVG stays and the user
        // sees a coin either way.
        console.warn('Supporter coin fell back to the flat rendering:', error);
      });

    return () => {
      disposed = true;
      handle = null;
      live?.dispose();
    };
  });

  // Reads `celebrate` and the handle, nothing else — so it fires on a bump,
  // and once more if the bump beat the dynamic import home.
  $effect(() => {
    if (celebrate > 0) handle?.celebrate();
  });
</script>

<div class="supporter-coin" role="img" aria-label={localizedText('license.coinAccessibilityLabel')}>
  <div
    class="supporter-coin-stage"
    class:supporter-coin-stage-live={handle !== null}
    bind:this={host}
  ></div>

  <svg class="supporter-coin-flat" viewBox="0 0 48 48" aria-hidden="true">
    <defs>
      <linearGradient id="supporter-coin-face" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ffd24d" />
        <stop offset="55%" stop-color="#ffbb00" />
        <stop offset="100%" stop-color="#b8860b" />
      </linearGradient>
    </defs>
    <path
      fill="url(#supporter-coin-face)"
      fill-rule="evenodd"
      d="M24 2a22 22 0 1 1 0 44 22 22 0 0 1 0-44Zm0 12.4-2.6 2.6a4 4 0 0 0 0 5.6l1.4 1.4-1.4 1.4a4 4 0 0 0 0 5.6L24 33.6l2.6-2.6a4 4 0 0 0 0-5.6L25.2 24l1.4-1.4a4 4 0 0 0 0-5.6L24 14.4Z"
    />
  </svg>
</div>

<style>
  .supporter-coin {
    position: relative;
    width: 100%;
    height: 100%;
    line-height: 0;
  }

  .supporter-coin-stage,
  .supporter-coin-flat {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  /* The flat coin IS the rendering until the canvas has one, so the two are
     never both visible and the swap has nothing to flash. */
  .supporter-coin-stage-live + .supporter-coin-flat {
    visibility: hidden;
  }
</style>
