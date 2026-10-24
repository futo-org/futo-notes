# Disposable TLS fixtures

For local HTTPS QA, `just test-tls-fixture <new-directory> [DNS-or-IP ...]` generates a CA and
server certificate using the common OpenSSL/LibreSSL config-file interface. The parent
directory must exist; an existing output directory is refused.

```sh
mkdir -p verification-runs
just test-tls-fixture verification-runs/tls-example notes.test
```

The directory contains `ca.pem`, `server.pem`, PKCS8 `server-key.pem` and `ca-key.pem`,
plus the configuration/CSR/serial files used to produce them. Certificates last two days.
The CA explicitly has `CA:TRUE` and certificate-signing key usage; the server has `CA:FALSE`,
server-auth usage, and SANs for localhost, 127.0.0.1, ::1, and 10.0.2.2 plus any requested DNS/IP values.
Use the generated CA for the test client's trust and the server certificate/key for the test
server. The helper does not install certificates or modify a device/OS trust store.

The command works with macOS LibreSSL 3.3.6 and Linux OpenSSL. It uses config sections instead
of `openssl req -addext` or `openssl x509 -ext`, which older LibreSSL does not support. For manual
inspection, `openssl x509 -in <certificate> -noout -text` works on both. The helper verifies the
chain with `openssl verify`; automated tests also perform a real TLS handshake with the CA.

Generation failure removes only the new directory created by that invocation. No production
key or existing directory is read, overwritten, or cleaned up.
