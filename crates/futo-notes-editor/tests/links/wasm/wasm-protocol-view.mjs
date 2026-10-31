// One test view owns actual Store acknowledgement, ordering and transport retry.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export function protocolView(page, exchange, initialText = '', label = 'portable consumer') {
  let shown = initialText;
  let revision = BigInt(JSON.parse(page.status()).accepted);
  return {
    get text() {
      return shown;
    },
    get revision() {
      return revision;
    },
    async apply(request, reject = false) {
      const before = JSON.parse(page.status());
      const displayed = shown;
      const draft = page.draft_text();
      const localOverlay = page.composition();
      assert.equal(before.accepted, Number(revision), label);
      assert.throws(() => page.project(revision, 0, Buffer.byteLength(shown)));
      if (reject) {
        // Refusal is BEFORE real Store acceptance. Filesystem Append/ShortWrite
        // atomicity is proved separately through the Rust Store facade.
        const body = JSON.parse(request);
        const failed = JSON.stringify({
          token: body.token,
          sequence: body.sequence,
          accepted: before.accepted,
          durable: before.durable,
          paused: true,
          error: `injected ${label} transport rejection`,
        });
        assert.equal(JSON.parse(page.acknowledge(failed)), null);
        assert.equal(JSON.parse(page.status()).accepted, before.accepted);
        assert.equal(JSON.parse(page.status()).displayed, before.displayed);
        // The existing portable contract permits the copyable prepared draft;
        // neither it nor its local overlay is an accepted/displayed delta.
        assert.equal(page.draft_text(), draft);
        assert.equal(page.composition(), localOverlay);
        assert.equal(shown, displayed);
        assert.equal(
          JSON.parse(page.acknowledge(JSON.stringify(await exchange(page.resume())))),
          null,
        );
        request = page.retry_pending();
        assert.equal(JSON.parse(page.acknowledge(failed)), null);
      }
      const ack = await exchange(request);
      assert.equal(JSON.parse(page.status()).accepted, before.accepted);
      assert.equal(JSON.parse(page.status()).displayed, before.displayed);
      assert.equal(shown, displayed);
      assert.deepEqual(await exchange(request), ack);
      const change = JSON.parse(page.acknowledge(JSON.stringify(ack)));
      assert.ok(change, label);
      const bytes = Buffer.from(shown);
      shown = Buffer.concat([
        bytes.subarray(0, change.range.start),
        Buffer.from(change.inserted),
        bytes.subarray(change.range.end),
      ]).toString();
      revision = BigInt(change.revision);
      assert.equal(revision, BigInt(before.accepted) + 1n);
      assert.equal(JSON.parse(page.acknowledge(JSON.stringify(ack))), null);
      return change;
    },
  };
}
