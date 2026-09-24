import test from 'node:test';
import assert from 'node:assert/strict';
import { createCountryProfileServer } from 'realaddr/server';
import { generateProfileByCountry, generateProfileByProxy, createCountryProfileGenerator, InputError } from 'realaddr';

const component = (type, longText, shortText = longText) => ({ types: [type], longText, shortText });
const place = { location: { latitude: 37.4, longitude: -122.1 }, addressComponents: [
  component('country', 'United States', 'US'),
  component('administrative_area_level_1', 'California', 'CA'),
  component('locality', 'Sample City'), component('street_number', '123'),
  component('route', 'Main Street'), component('postal_code', '90210'),
] };
const googleFetch = async () => ({ ok: true, json: async () => ({ places: [place] }) });
const fields = ['firstName', 'lastName', 'address', 'city', 'state', 'stateName', 'zip', 'phone', 'email', 'password'];
const options = { apiKey: 'test-key', fetchImpl: googleFetch };

test('JSON option returns the same ten cleaned fields as the text format', async () => {
  const data = await generateProfileByCountry('US', { ...options, format: 'json' });
  assert.deepEqual(Object.keys(data), fields);
  assert.ok(Object.values(data).every(value => typeof value === 'string' && value.length > 0 && !/[|\r\n]/.test(value)));
  assert.deepEqual([data.address, data.city, data.state, data.stateName, data.zip], ['123 Main Street', 'Sample City', 'CA', 'California', '90210']);
  const text = await generateProfileByCountry('US', options);
  assert.equal(typeof text, 'string');
  assert.equal(text.split('|').length, 10);
  await assert.rejects(generateProfileByCountry('US', { ...options, format: 'xml', fetchImpl: () => assert.fail('Unexpected request') }), InputError);
});

test('proxy generation also supports JSON and returns null when lookup fails', async () => {
  const proxyFetchImpl = async () => ({ ok: true, json: async () => ({
    success: true, ip: '8.8.8.8', country_code: 'US', region: 'California', city: 'Mountain View', latitude: 37.4, longitude: -122.1,
  }) });
  const data = await generateProfileByProxy('http://127.0.0.1:8080', { ...options, format: 'json', proxyFetchImpl });
  assert.deepEqual(Object.keys(data), fields);
  assert.equal(data.state, 'CA');
  assert.equal(await generateProfileByProxy('http://127.0.0.1:8080', {
    ...options, format: 'json', proxyFetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  }), null);
  await assert.rejects(generateProfileByProxy('http://127.0.0.1:8080', {
    ...options, format: 'xml', proxyFetchImpl: () => assert.fail('Unexpected request'),
  }), InputError);
});

test('HTTP format=json returns an object or JSON null with the correct content type', async t => {
  const server = createCountryProfileServer(createCountryProfileGenerator(options));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/generate`;
  const json = await fetch(`${base}?country=US&format=json`);
  assert.equal(json.status, 200);
  assert.match(json.headers.get('content-type'), /application\/json/);
  assert.deepEqual(Object.keys(await json.json()), fields);
  const text = await fetch(`${base}?country=US`);
  assert.match(text.headers.get('content-type'), /text\/plain/);
  assert.equal((await text.text()).trim().split('|').length, 10);
  for (const query of ['country=US&format=xml', 'country=US&format=json&format=text', 'country=US&format=json&extra=1']) {
    assert.equal((await fetch(`${base}?${query}`)).status, 400);
  }
  const missing = await fetch(`${base}?country=XX&format=json`);
  assert.equal(missing.status, 400);
  assert.match(missing.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await missing.json()).error, 'string');
});

test('HTTP format=json serializes an incomplete result as JSON null', async t => {
  const server = createCountryProfileServer(async () => null);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await fetch(`http://127.0.0.1:${server.address().port}/generate?country=US&format=json`);
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-type'), /application\/json/);
  assert.equal(await result.json(), null);
});
