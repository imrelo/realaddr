import test from 'node:test';
import assert from 'node:assert/strict';
import { generateProfileByCountry, createCountryProfileGenerator, GoogleApiError } from 'realaddr';
import { createCountryProfileServer } from 'realaddr/server';

const component = (type, value, short = value) => ({ types: [type], longText: value, shortText: short });
const complete = { addressComponents: [
  component('country', 'United States', 'US'), component('administrative_area_level_1', 'California', 'CA'),
  component('locality', 'Sample City'), component('street_number', '123'), component('route', 'Main Street'), component('postal_code', '90210')
] };
const result = places => ({ ok: true, json: async () => ({ places }) });

test('public factory isolates configuration and import does not start a server', async () => {
  const options = { apiKey: 'first-key', referer: '', fetchImpl: async (_url, init) => {
    assert.equal(init.headers['X-Goog-Api-Key'], 'first-key');
    assert.equal(init.headers.Referer, undefined);
    return result([complete]);
  } };
  const first = createCountryProfileGenerator(options);
  options.apiKey = 'changed-key';
  const second = createCountryProfileGenerator({ apiKey: 'second-key', fetchImpl: async (_url, init) => {
    assert.equal(init.headers['X-Goog-Api-Key'], 'second-key');
    return result([complete]);
  } });
  for (const record of await Promise.all([first('US'), second('US')])) assert.equal(record.split('|').length, 10);
  assert.equal(createCountryProfileServer().listening, false);
});

test('a complete candidate prevents wasted retries when mixed with malformed or incomplete places', async () => {
  let calls = 0;
  const incomplete = { addressComponents: complete.addressComponents.filter(c => !c.types.includes('postal_code')) };
  for (let i = 0; i < 20; i++) {
    const record = await generateProfileByCountry('US', { apiKey: 'test-key', fetchImpl: async () => {
      calls++;
      return result([null, {}, { addressComponents: [null] }, { addressComponents: {} }, incomplete, complete]);
    } });
    assert.ok(record);
  }
  assert.equal(calls, 20);
});

test('cancellation and invalid timeout stop before network activity', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return result([complete]); };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generateProfileByCountry('US', { apiKey: 'test-key', fetchImpl, signal: controller.signal }), { name: 'AbortError' });
  for (const timeoutMs of [0, -1, 1.5, Infinity, '100']) await assert.rejects(generateProfileByCountry('US', { apiKey: 'test-key', fetchImpl, timeoutMs }), /timeoutMs/);
  assert.equal(calls, 0);
});

test('request timeout aborts the fetch without retrying', async () => {
  let calls = 0;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(generateProfileByCountry('US', { apiKey: 'test-key', timeoutMs: 5, fetchImpl: async (_url, { signal }) => {
      calls++;
      return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    } }), { name: 'TimeoutError' });
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(calls, 1);
});

test('provider error exposes status, releases response and omits secrets', async () => {
  let cancelled = false;
  await assert.rejects(generateProfileByCountry('US', { apiKey: 'secret-key', fetchImpl: async () => ({
    ok: false, status: 429, body: { cancel: async () => { cancelled = true; } }
  }) }), error => {
    assert.ok(error instanceof GoogleApiError);
    assert.equal(error.status, 429);
    assert.ok(!error.message.includes('secret-key'));
    return true;
  });
  assert.ok(cancelled);
});
