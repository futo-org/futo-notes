import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';

import { visitAsBrowser } from './standin-browser.mjs';

const servers = [];

/** A loopback server on an arbitrary free port, torn down after each test. */
async function serve(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('visitAsBrowser', () => {
  // The whole reason this exists: the stand-in login chain sets a cookie at one
  // hop and reads it at another, and `fetch`'s own redirect following has no
  // cookie jar — so a plain fetch reaches the end of the chain signed out.
  it('carries a cookie set mid-redirect through to the end of the chain', async () => {
    const seen = [];
    const base = await serve((request, response) => {
      seen.push([request.url, request.headers.cookie ?? null]);
      if (request.url === '/start') {
        response.writeHead(302, {
          'set-cookie': 'oidc_flow=abc123; Path=/; HttpOnly',
          location: '/finish',
        });
        response.end();
        return;
      }
      if (request.url === '/finish' && request.headers.cookie?.includes('oidc_flow=abc123')) {
        response.writeHead(200).end('signed in');
        return;
      }
      response.writeHead(401).end('no cookie');
    });

    await visitAsBrowser(`${base}/start`);

    expect(seen).toEqual([
      ['/start', null],
      ['/finish', 'oidc_flow=abc123'],
    ]);
  });

  it('follows a redirect to another origin, as one loopback port to another', async () => {
    const issuer = await serve((_request, response) => response.writeHead(200).end('issuer'));
    const base = await serve((_request, response) => {
      response.writeHead(302, { location: `${issuer}/authorize` }).end();
    });

    const { finalUrl } = await visitAsBrowser(`${base}/start`);

    expect(finalUrl).toBe(`${issuer}/authorize`);
  });

  // A hand-off that was never opened leaves the app polling until its wait gives
  // up, and "the wizard timed out" says nothing about the 500 that happened.
  it('reports the status and body of a page that failed', async () => {
    const base = await serve((_request, response) => {
      response.writeHead(500).end('the stand-in issuer fell over');
    });

    await expect(visitAsBrowser(`${base}/start`)).rejects.toThrow(
      /HTTP 500: the stand-in issuer fell over/,
    );
  });

  it('gives up on a redirect loop instead of spinning', async () => {
    const base = await serve((_request, response) => {
      response.writeHead(302, { location: '/again' }).end();
    });

    await expect(visitAsBrowser(`${base}/start`, { maxRedirects: 3 })).rejects.toThrow(
      /more than 3 redirects/,
    );
  });

  it('forgets a cookie the chain clears rather than sending an empty one', async () => {
    const seen = [];
    const base = await serve((request, response) => {
      seen.push(request.headers.cookie ?? null);
      if (request.url === '/start') {
        response
          .writeHead(302, { 'set-cookie': 'oidc_flow=abc123; Path=/', location: '/logout' })
          .end();
        return;
      }
      if (request.url === '/logout') {
        response.writeHead(302, { 'set-cookie': 'oidc_flow=; Path=/', location: '/done' }).end();
        return;
      }
      response.writeHead(200).end('done');
    });

    await visitAsBrowser(`${base}/start`);

    expect(seen).toEqual([null, 'oidc_flow=abc123', null]);
  });

  it('names the URL it could not reach at all', async () => {
    // Port 1 on loopback: nothing listens, and nothing is allowed to.
    await expect(visitAsBrowser('http://127.0.0.1:1/start')).rejects.toThrow(
      /browser visit of http:\/\/127\.0\.0\.1:1\/start failed/,
    );
  });
});
