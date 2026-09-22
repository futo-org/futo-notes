/**
 * The browser the hosted scenarios do not have, and the account controls they
 * cannot reach from inside the app.
 *
 * Sign-in and checkout are finished in a browser: the app opens a URL and then
 * polls the server for the outcome. A test process must not pop a real browser
 * onto somebody's desktop, so this fetches the URL instead — with the two things
 * that make a fetch browser-shaped:
 *
 *   - it follows redirects itself, and
 *   - it carries cookies across them.
 *
 * Both matter. The stand-in server's login chain bounces through the stand-in
 * issuer and sets an `oidc_flow` cookie at the callback; a client that drops it
 * never signs in, and `fetch`'s built-in redirect following has no cookie jar.
 * Cookies are not port-scoped in a browser either, which is why one flat jar is
 * right here: the server and its stand-in issuer are two ports on 127.0.0.1 and
 * a real browser would share cookies between them.
 *
 * `lapse` and `fillQuota` are the stand-in server's own account controls
 * (`cmd/server/standin.go`, mounted only under `STANDIN_MODE`). They act for
 * whichever account's token is passed, which is how a scenario reaches a real
 * `402 subscription_required` or `507 quota_exceeded` without cancelling a card
 * or uploading ten gigabytes.
 */

/**
 * Open [url] the way the platform auth sheet would, and follow it to the end.
 *
 * Throws on a non-2xx landing: an unvisited hand-off leaves the app polling
 * until its wait gives up, and "the wizard timed out" says nothing about the
 * 500 that actually happened.
 */
export async function visitAsBrowser(url, { maxRedirects = 20 } = {}) {
  const jar = new Map();
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const headers = {};
    const cookie = cookieHeader(jar);
    if (cookie) headers.cookie = cookie;

    const response = await fetch(current, { redirect: 'manual', headers }).catch((cause) => {
      throw new Error(`browser visit of ${current} failed: ${cause.message}`, { cause });
    });
    storeCookies(jar, response.headers.getSetCookie());

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`browser visit of ${current} answered HTTP ${response.status}: ${body}`);
    }
    return { finalUrl: current, status: response.status };
  }

  throw new Error(`browser visit of ${url} followed more than ${maxRedirects} redirects`);
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function storeCookies(jar, setCookies) {
  for (const line of setCookies) {
    const [pair] = line.split(';');
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    // A cookie cleared with an empty value is gone, not stored as empty — a
    // logout in the chain must not leave a dead `oidc_flow` behind.
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

/** Stops the account writing, the way a real cancellation would. */
export async function lapseSubscription(serverUrl, token) {
  await standinControl(serverUrl, token, '/standin/lapse');
}

/**
 * Drops the plan's ceiling to what the account already stores, so the next byte
 * is refused.
 *
 * An account that has stored NOTHING gets a quota of zero, which every shell
 * reads as "not known yet" rather than "full" — so a scenario must sync
 * something before calling this, or it will produce no banner at all. That is
 * how the iOS and Android wizard tickets (#178, #179) ended up unable to prove
 * the Vault is full banner on a device.
 */
export async function fillQuota(serverUrl, token) {
  await standinControl(serverUrl, token, '/standin/quota');
}

/** Puts a quota back, in bytes. */
export async function setQuota(serverUrl, token, storageQuotaBytes) {
  await standinControl(serverUrl, token, '/standin/quota', {
    storage_quota_bytes: storageQuotaBytes,
  });
}

async function standinControl(serverUrl, token, path, body) {
  if (!token) throw new Error(`${path} needs the signed-in account's session token, and got none`);
  const response = await fetch(`${serverUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw new Error(`POST ${path} answered HTTP ${response.status}: ${text}`);
  }
}
