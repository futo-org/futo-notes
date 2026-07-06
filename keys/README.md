# keys/

## `localdev-updater.key` (+ `.pub`) — committed on purpose

A **throwaway** minisign keypair (key id `3CBB0961AFCA9C80`) for local updater
testing. It is the *signing* key for the **localdev** release profile (see
`scripts/release-build.mjs` and `apps/tauri/src-tauri/tauri.updater-localdev.conf.json`).

**Committing this private key is intentional and safe.** It protects nothing:

- It only ever signs builds served from `http://localhost` to a build made with
  the localdev overlay (which bakes the matching localdev pubkey).
- A **production** client bakes the **production** pubkey (`tauri.conf.json`,
  key id `5955F098…`), so anything this key signs **fails verification on prod
  by construction.** There is no path for a localdev-signed artifact to be
  accepted by a real install.

`updaterConfig.test.ts` enforces the trust boundary: the localhost endpoint,
the insecure-transport flag, and this localdev pubkey may appear **only** in the
localdev overlay — never in `tauri.conf.json` (prod) or the release overlay.

## Production key — NOT here

The production private key lives in GitLab CI/CD variables
(`TAURI_SIGNING_PRIVATE_KEY`), never in the repo. Only its public half is
committed, in `tauri.conf.json`. Losing the production private key means no
shipped client can ever auto-update again (the baked pubkey can't be rotated for
existing installs) — back it up in a vault, not here.

## Regenerating the localdev key

```bash
cargo tauri signer generate -w keys/localdev-updater.key -p "" -f --ci
```

Then paste the new `keys/localdev-updater.key.pub` contents into the localdev
overlay's `plugins.updater.pubkey` (and update the key-id references above).
