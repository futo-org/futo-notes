#!/usr/bin/env node
// Disposable QA TLS files using OpenSSL/LibreSSL's shared config-file syntax.
// Creates a new directory only; never installs trust or reads production keys.
// Outputs a CA plus server certificate and PKCS8 keys, with explicit constraints,
// key usage and SANs. No -addext/-ext dependency (macOS LibreSSL lacks those).
import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { execFileSync } from 'node:child_process';

function main(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: just test-tls-fixture <new-output-directory> [DNS-or-IP ...]
Example: mkdir -p verification-runs
         just test-tls-fixture verification-runs/tls-example notes.test
Parent must exist; existing output paths are refused. Creates two-day ca.pem,
server.pem, PKCS8 ca-key.pem/server-key.pem and config/CSR/serial files.
CA:TRUE with signing usage; server CA:FALSE with server-auth and SANs for
localhost,127.0.0.1,::1,10.0.2.2 plus requested hosts. Trust the CA in the test
client; use the server certificate/key on the test server. Never installs OS/device trust.
Uses shared config syntax for macOS LibreSSL 3.3.6/Linux OpenSSL (no -addext/-ext).
Inspect with: openssl x509 -in <certificate> -noout -text
Generation verifies the chain with openssl verify; tests also perform a TLS handshake.
Failure removes only this invocation's new directory; existing paths and production keys
are never read, overwritten or removed.`);
    return;
  }
  const [directory, ...extraHosts] = args;
  if (!directory || directory.startsWith('-'))
    throw new Error('Expected a new output directory (see --help)');
  const hosts = [...new Set(['localhost', '127.0.0.1', '::1', '10.0.2.2', ...extraHosts])];
  const dns =
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
  for (const host of hosts) {
    if (host.includes('%') || (!isIP(host) && (host.length > 253 || !dns.test(host))))
      throw new Error(`Invalid DNS/IP SAN: ${JSON.stringify(host)}`);
  }
  const out = path.resolve(directory);
  fs.mkdirSync(out, { mode: 0o700 }); // EEXIST refuses files, directories and symlinks.
  const openssl = (...command) =>
    execFileSync('openssl', command, {
      cwd: out,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  try {
    fs.writeFileSync(
      path.join(out, 'ca.cnf'),
      `[req]
prompt = no
distinguished_name = dn
x509_extensions = ca_cert
[dn]
CN = FUTO Notes QA CA
[ca_cert]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
`,
    );
    let dnsIndex = 0;
    let ipIndex = 0;
    const sans = hosts
      .map((host) => (isIP(host) ? `IP.${++ipIndex} = ${host}` : `DNS.${++dnsIndex} = ${host}`))
      .join('\n');
    fs.writeFileSync(
      path.join(out, 'server.cnf'),
      `[req]
prompt = no
distinguished_name = dn
req_extensions = server_cert
[dn]
CN = FUTO Notes QA server
[server_cert]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @sans
[sans]
${sans}
`,
    );
    for (const key of ['ca-key.pem', 'server-key.pem']) {
      openssl('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', key);
      fs.chmodSync(path.join(out, key), 0o600);
    }
    openssl(
      'req',
      '-new',
      '-x509',
      '-sha256',
      '-days',
      '2',
      '-key',
      'ca-key.pem',
      '-out',
      'ca.pem',
      '-config',
      'ca.cnf',
    );
    openssl(
      'req',
      '-new',
      '-sha256',
      '-key',
      'server-key.pem',
      '-out',
      'server.csr',
      '-config',
      'server.cnf',
    );
    openssl(
      'x509',
      '-req',
      '-sha256',
      '-days',
      '2',
      '-in',
      'server.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca-key.pem',
      '-CAcreateserial',
      '-out',
      'server.pem',
      '-extfile',
      'server.cnf',
      '-extensions',
      'server_cert',
    );
    openssl('verify', '-CAfile', 'ca.pem', 'server.pem');
    console.log(
      `QA TLS fixture: ${out}\nCA: ca.pem; server: server.pem; private server key: server-key.pem`,
    );
  } catch (error) {
    fs.rmSync(out, { recursive: true, force: true }); // Only the directory created above.
    throw new Error(
      `QA TLS generation failed: ${error.stderr?.toString().trim() || error.message}`,
    );
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
