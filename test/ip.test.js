import test from 'node:test';
import assert from 'node:assert/strict';
import { generateProfileByCountry, generateProfileByProxy, InputError } from 'realaddr';
import { createCountryProfileServer } from 'realaddr/server';
import { withinViewport, rectangleAround } from '../src/ip-location.js';

const proxy = 'http://127.0.0.1:8080';
const geo = { success: true, ip: '8.8.8.8', country_code: 'US', region: 'California', city: 'Mountain View', latitude: 37.4, longitude: -122.1 };
const fallback = { ip: '8.8.8.8', country: 'US', stateProv: 'California', city: 'Mountain View', ll: ['37.4', '-122.1'] };
const c = (type, value, shortText = value) => ({ types: [type], longText: value, shortText });
const place = (state = 'CA', latitude = 37.4, country = 'US') => ({ location: { latitude, longitude: -122.1 }, addressComponents: [c('country', country), c('administrative_area_level_1', state === 'CA' ? 'California' : 'New York', state), c('locality', 'Sample City'), c('route', 'Main Street'), c('street_number', '1'), c('postal_code', '94043')] });
const response = data => ({ ok: true, json: async () => data });

test('generateProfileByCountry accepts a country and rejects IP without reaching a provider', async () => {
  await assert.rejects(generateProfileByCountry('8.8.8.8', { fetchImpl: () => assert.fail('Unexpected request') }), InputError);
  await assert.rejects(generateProfileByCountry('2001:4860:4860::8888', { fetchImpl: () => assert.fail('Unexpected request') }), InputError);
});

test('generateProfileByProxy checks location once and restricts Google to its viewport and state', async () => {
  let lookups = 0, searches = 0;
  const record = await generateProfileByProxy(proxy, { apiKey: 'secret',
    proxyFetchImpl: async url => { lookups++; assert.equal(url, 'https://ipwho.is/'); return response(geo); },
    fetchImpl: async (url, init) => {
      searches++;
      assert.equal(url, 'https://places.googleapis.com/v1/places:searchText');
      const body = JSON.parse(init.body);
      assert.ok(withinViewport(place().location, body.locationRestriction.rectangle));
      assert.equal(init.headers['X-Goog-FieldMask'], 'places.addressComponents,places.location');
      return response({ places: [place('NY'), place('CA', 45), place('CA', 37.4, 'CA'), place()] });
    } });
  assert.equal(record.split('|')[4], 'CA');
  assert.equal(lookups, 1);
  assert.equal(searches, 1);
});

test('proxy fallback location is reused for all four Google attempts', async () => {
  let lookups = 0, searches = 0;
  const bounds = [];
  const record = await generateProfileByProxy(proxy, { apiKey: 'test',
    proxyFetchImpl: async () => ++lookups === 1 ? response({ success: false }) : response(fallback),
    fetchImpl: async (_url, init) => {
      searches++;
      bounds.push(JSON.parse(init.body).locationRestriction);
      return response({ places: [place('NY'), place('CA', 45)] });
    } });
  assert.equal(record, null);
  assert.equal(lookups, 2);
  assert.equal(searches, 4);
  assert.ok(bounds.every(value => JSON.stringify(value) === JSON.stringify(bounds[0])));
});

test('failed proxy lookup returns null; excluded US regions never yield a record', async () => {
  let searches = 0;
  const options = { apiKey: 'test', fetchImpl: async () => { searches++; return response({ places: [place()] }); } };
  assert.equal(await generateProfileByProxy(proxy, { ...options, proxyFetchImpl: async () => response({}) }), null);
  for (const state of ['Hawaii', 'Alaska', 'Puerto Rico']) {
    assert.equal(await generateProfileByProxy(proxy, { ...options, proxyFetchImpl: async () => response({ ...geo, region: state }) }), null);
  }
  assert.equal(searches, 12);
});

test('viewport handles antimeridian and polar locations', () => {
  const rectangle = rectangleAround(37.4, 179.99);
  assert.ok(rectangle.low.longitude > rectangle.high.longitude);
  assert.ok(withinViewport({ latitude: 37.4, longitude: -179.99 }, rectangle));
  assert.ok(!withinViewport({ latitude: 37.4, longitude: 0 }, rectangle));
  const polar = rectangleAround(90, 0);
  assert.equal(polar.high.latitude, 90);
  assert.ok(withinViewport({ latitude: 90, longitude: 0 }, polar));
});

test('HTTP accepts only country and rejects ip parameter', async t => {
  const received = [];
  const server = createCountryProfileServer(async input => { received.push(input); return null; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/generate`;
  assert.equal((await fetch(`${base}?country=US`)).status, 200);
  for (const query of ['ip=8.8.8.8', 'country=US&ip=8.8.8.8', 'country=US&country=VN']) assert.equal((await fetch(`${base}?${query}`)).status, 400);
  assert.deepEqual(received, ['US']);
});
