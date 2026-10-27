import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./test-tls-fixture.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });

it('creates a valid CA, PKCS8 server key and SAN certificate accepted in a real TLS handshake', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-tls-fixture-'));
  let server;
  try {
    const out = path.join(scratch, 'certs');
    const result = run(out, 'notes.test');
    expect(result.status, result.stderr).toBe(0);
    const caPem = fs.readFileSync(path.join(out, 'ca.pem'));
    const serverPem = fs.readFileSync(path.join(out, 'server.pem'));
    const key = fs.readFileSync(path.join(out, 'server-key.pem'));
    const ca = new X509Certificate(caPem);
    const cert = new X509Certificate(serverPem);
    expect(ca.ca).toBe(true);
    expect(cert.ca).toBe(false);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.checkHost('notes.test')).toBe('notes.test');
    expect(cert.checkHost('localhost')).toBe('localhost');
    expect(cert.checkIP('10.0.2.2')).toBe('10.0.2.2');
    expect(cert.checkIP('::1')).toBe('::1');
    expect(key.toString().startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
    server = https.createServer({ key, cert: serverPem }, (_request, response) =>
      response.end('trusted'),
    );
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const body = await new Promise((resolve, reject) => {
      https
        .get(
          {
            host: '127.0.0.1',
            port: server.address().port,
            ca: caPem,
            servername: 'notes.test',
            rejectUnauthorized: true,
          },
          (response) => {
            let text = '';
            response.on('data', (chunk) => {
              text += chunk;
            });
            response.on('end', () => resolve(text));
          },
        )
        .once('error', reject);
    });
    expect(body).toBe('trusted');
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

it('refuses existing outputs and invalid SANs before overwriting or creating files', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-tls-safety-'));
  try {
    const marker = path.join(scratch, 'keep');
    fs.writeFileSync(marker, 'existing');
    expect(run(scratch).status).not.toBe(0);
    expect(fs.readFileSync(marker, 'utf8')).toBe('existing');
    const out = path.join(scratch, 'invalid');
    expect(run(out, 'example.test\nCA:TRUE').status).not.toBe(0);
    expect(fs.existsSync(out)).toBe(false);
    expect(run('--help').status).toBe(0);
    const bin = path.join(scratch, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'openssl'),
      `#!${process.execPath}\nprocess.stderr.write('injected OpenSSL failure'); process.exit(2);\n`,
      { mode: 0o755 },
    );
    const failed = spawnSync(process.execPath, [entry, out], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('injected OpenSSL failure');
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readFileSync(marker, 'utf8')).toBe('existing');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

it('runs when its script is reached through a directory alias, as with macOS /var', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-tls-alias-'));
  try {
    const alias = path.join(scratch, 'scripts');
    fs.symlinkSync(path.dirname(entry), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const out = path.join(scratch, 'certs');
    const result = spawnSync(process.execPath, [path.join(alias, path.basename(entry)), out], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(out, 'ca.pem'))).toBe(true);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
