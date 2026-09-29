import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceCredentialStore, DeviceStorageError } from '../upload/device-credential.mjs';

const token = 'Synthetic-Device-Test-Only';
function memoryVault() {
  let revision = 0, record = null;
  return {
    async read() { return { revision: String(revision), record: structuredClone(record) }; },
    async write(next, expected) {
      if (String(revision) !== expected) throw new Error('stale write');
      record = structuredClone(next); return String(++revision);
    },
    async forget(expected) {
      if (expected !== undefined && String(revision) !== expected) return false;
      record = null; revision++; return true;
    },
    corrupt() { new Uint8Array(record.ciphertext)[0] ^= 1; },
  };
}

test('device storage roundtrips through a cloned non-extractable key and keeps plaintext out of the record', async () => {
  const vault = memoryVault(), first = createDeviceCredentialStore({ vault });
  assert.equal(await first.load(), null);
  const revision = await first.remember(token);
  const stored = await vault.read();
  assert.equal(stored.record.key.extractable, false);
  assert.equal(stored.record.key.algorithm.name, 'AES-GCM');
  assert.equal(stored.record.key.algorithm.length, 256);
  assert.equal(JSON.stringify(stored.record).includes(token), false);
  assert.equal(new TextDecoder().decode(stored.record.ciphertext).includes(token), false);
  const reopened = createDeviceCredentialStore({ vault });
  assert.deepEqual(await reopened.snapshot(), { token, revision });
  assert.equal(await reopened.forget(), true);
  assert.equal(await first.load(), null);
});

test('invalid data and storage exceptions return a fixed message without leaking the credential', async () => {
  const broken = createDeviceCredentialStore({ vault: { async read() { throw new Error(token); } } });
  await assert.rejects(broken.load(), error => error instanceof DeviceStorageError && !error.message.includes(token));
  const vault = memoryVault(), store = createDeviceCredentialStore({ vault });
  await store.remember(token); vault.corrupt();
  await assert.rejects(store.load(), DeviceStorageError);
  await assert.rejects(store.remember('bad token'), DeviceStorageError);
  await store.forget();
  assert.equal(await store.load(), null);
});

test('forget in another tab blocks an in-flight encrypted write from restoring a token', async () => {
  const vault = memoryVault();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const delayedCrypto = {
    getRandomValues: crypto.getRandomValues.bind(crypto),
    subtle: {
      async generateKey(...args) { enter(); await resume; return crypto.subtle.generateKey(...args); },
      encrypt: crypto.subtle.encrypt.bind(crypto.subtle),
      decrypt: crypto.subtle.decrypt.bind(crypto.subtle),
    },
  };
  const first = createDeviceCredentialStore({ vault, cryptoApi: delayedCrypto });
  const second = createDeviceCredentialStore({ vault });
  const saving = first.remember(token);
  const rejected = assert.rejects(saving, DeviceStorageError);
  await entered; await second.forget(); release();
  await rejected;
  assert.equal(await second.load(), null);
});

test('stale connection or 401 cleanup cannot replace or delete a newer connection', async () => {
  const vault = memoryVault(), store = createDeviceCredentialStore({ vault });
  const oldRevision = await store.revision();
  await store.forget();
  await assert.rejects(store.remember(token, { expectedRevision: oldRevision }), DeviceStorageError);
  const newRevision = await store.remember(token);
  assert.equal(await store.forget({ expectedRevision: oldRevision }), false);
  assert.deepEqual(await store.snapshot(), { token, revision: newRevision });
  assert.equal(await store.forget({ expectedRevision: newRevision }), true);
  assert.equal(await store.load(), null);
});
