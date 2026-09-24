import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rectangleAround, withinViewport } from './ip-location.js';
import { lookupProxyLocation } from './proxy-ip.js';
import { countryCode, countryName } from './countries.js';
import examples from 'libphonenumber-js/mobile/examples';
import { getExampleNumber, parsePhoneNumberFromString } from 'libphonenumber-js/max';
import usAreaCodes from './us-area-codes.json' with { type: 'json' };

const mainlandStates = Object.keys(usAreaCodes.states);
const mainland = new Set(mainlandStates);
const pick = values => values[randomInt(values.length)];
function readNames(filename) {
  const names = readFileSync(new URL(filename, import.meta.url), 'utf8').split(/\r\n|\n|\r/).map(name => name.trim()).filter(Boolean);
  if (!names.length) throw new Error(`${filename} must contain at least one name`);
  return names;
}
const firstNames = readNames('./firstname.txt');
const lastNames = readNames('./lastname.txt');
const emailDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com', 'live.com', 'msn.com', 'proton.me', 'mail.com'];

function emailFor(firstName, lastName) {
  const normalize = name => name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/g, 'd').replace(/[^a-z0-9]/g, '').slice(0, 27);
  let suffix;
  do {
    suffix = Array.from({ length: 6 }, () => pick('abcdefghijklmnopqrstuvwxyz0123456789')).join('');
  } while (!/[a-z]/.test(suffix) || !/[0-9]/.test(suffix));
  return `${normalize(firstName) || 'user'}.${normalize(lastName) || 'mail'}.${suffix}@${pick(emailDomains)}`;
}

export class InputError extends Error {}
export class GoogleApiError extends Error {
  constructor(status) {
    super(`Google Places returned HTTP ${status}. Check API key, Places API (New), billing and key restrictions.`);
    this.name = 'GoogleApiError';
    this.status = status;
  }
}
class IncompleteRecordError extends Error {}
export function resolveCountry(input) {
  if (typeof input !== 'string' || !input.trim()) throw new InputError('country is required');
  const code = countryCode(input);
  if (!code) throw new InputError('Unknown country. Use ISO code, e.g. US, VN, GB.');
  return code;
}

export function password() {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '0123456789', '!@#$%^&*_-+=?'];
  const chars = groups.map(pick);
  const alphabet = groups.join('');
  const length = randomInt(8, 13);
  while (chars.length < length) chars.push(pick(alphabet));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function phoneFor(country, state) {
  if (country === 'US') {
    const areaCodes = Object.hasOwn(usAreaCodes.states, state) ? usAreaCodes.states[state] : null;
    if (!areaCodes?.length) throw new InputError(`Unsupported US state for phone generation: ${state}`);
    for (let attempt = 0; attempt < 1000; attempt++) {
      const areaCode = pick(areaCodes);
      const exchange = String(randomInt(200, 1000));
      if (exchange.endsWith('11')) continue;
      const subscriber = String(randomInt(10000)).padStart(4, '0');
      const phone = parsePhoneNumberFromString(`+1${areaCode}${exchange}${subscriber}`);
      if (phone?.country === 'US' && phone.isValid()) return phone.nationalNumber;
    }
    throw new Error(`Could not generate a valid phone format for US state ${state}`);
  }
  const example = getExampleNumber(country, examples);
  if (!example) throw new InputError(`Phone numbering data unavailable for ${country}`);
  const base = example.nationalNumber;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const length = Math.min(4, base.length - 3);
    const national = base.slice(0, -length) + String(randomInt(10 ** length)).padStart(length, '0');
    const phone = parsePhoneNumberFromString(national, country);
    if (phone?.country === country && phone.isValid()) return phone.nationalNumber;
  }
  throw new Error(`Could not generate a valid phone format for ${country}`);
}

export function addressFrom(place, country) {
  if (!Array.isArray(place?.addressComponents)) return null;
  const components = new Map();
  for (const component of place.addressComponents) {
    if (!Array.isArray(component?.types)) continue;
    for (const type of component.types) {
      if (!components.has(type)) components.set(type, component);
    }
  }
  const get = (type, short = false) => {
    const value = components.get(type)?.[short ? 'shortText' : 'longText'];
    return typeof value === 'string' ? value.replace(/[|\r\n]+/g, ' ').trim() : '';
  };
  if (get('country', true) !== country) return null;
  const state = get('administrative_area_level_1', true);
  const stateName = get('administrative_area_level_1');
  if (country === 'US' && !mainland.has(state)) return null;
  const route = get('route');
  const address = route ? [get('street_number'), route].filter(Boolean).join(' ') : get('premise');
  const city = get('locality') || get('postal_town') || get('administrative_area_level_3') || get('administrative_area_level_2');
  const zip = get('postal_code');
  if (!address || !city || !state || !stateName || !zip || (country === 'US' && !get('street_number'))) return null;
  return { address, city, state, stateName, zip };
}

export async function findAddress(country, { apiKey = process.env.GOOGLE_API_KEY, referer = process.env.GOOGLE_REFERER, fetchImpl = fetch, searchAttempts = 3, timeoutMs = 15000, signal, ipLocation } = {}) {
  if (!apiKey) throw new Error('Set GOOGLE_API_KEY in .env');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new InputError('timeoutMs must be an integer from 1 to 2147483647');
  if (typeof fetchImpl !== 'function') throw new InputError('fetchImpl must be a function');
  signal?.throwIfAborted();
  const name = countryName(country);
  const queries = ['libraries', 'museums', 'hotels'];
  // Shuffle searches so repeated calls are not tied to a single place category.
  for (let i = queries.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [queries[i], queries[j]] = [queries[j], queries[i]];
  }
  for (const category of queries.slice(0, searchAttempts)) {
    signal?.throwIfAborted();
    const region = country === 'US' ? `${pick(mainlandStates)}, United States` : name;
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': ipLocation ? 'places.addressComponents,places.location' : 'places.addressComponents',
        ...(referer ? { Referer: referer } : {})
      },
      body: JSON.stringify({ textQuery: ipLocation ? category : `${category} in ${region}`, languageCode: 'en', pageSize: 20,
        ...(ipLocation ? { locationRestriction: { rectangle: ipLocation.rectangle } } : {}) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!response.ok) {
      // Release the response stream without including provider text or secrets in errors.
      await response.body?.cancel();
      throw new GoogleApiError(response.status);
    }
    const data = await response.json();
    const addresses = (Array.isArray(data?.places) ? data.places : [])
      .filter(place => !ipLocation || withinViewport(place?.location, ipLocation.rectangle))
      .map(place => addressFrom(place, country))
      .filter(address => address && (!ipLocation || country !== 'US' || address.stateName.toLowerCase() === ipLocation.state.toLowerCase()));
    if (addresses.length) return pick(addresses);
  }
  throw new IncompleteRecordError(`No usable public-place address found in ${country}. Try again.`);
}

export function serialize(fields) {
  return fields.map(value => String(value ?? '').replace(/[|\r\n]+/g, ' ').trim()).join('|');
}

const outputFields = ['firstName', 'lastName', 'address', 'city', 'state', 'stateName', 'zip', 'phone', 'email', 'password'];
function outputFormat(options) {
  const format = options.format ?? 'text';
  if (format !== 'text' && format !== 'json') throw new InputError('format must be text or json');
  return format;
}

async function generateRecord(country, options, ipLocation) {
  const format = outputFormat(options);
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      let phone = country === 'US' ? undefined : phoneFor(country);
      const location = await findAddress(country, { ...options, searchAttempts: 1, ipLocation });
      if (country === 'US') phone = phoneFor(country, location.state);
      const firstName = pick(firstNames);
      const lastName = pick(lastNames);
      const record = serialize([
        firstName, lastName,
        location.address, location.city, location.state, location.stateName, location.zip,
        phone, emailFor(firstName, lastName), password()
      ]);
      const fields = record.split('|');
      if (fields.length === outputFields.length && fields.every(Boolean)) {
        return format === 'json' ? Object.fromEntries(outputFields.map((name, index) => [name, fields[index]])) : record;
      }
    } catch (error) {
      if (!(error instanceof IncompleteRecordError)) throw error;
    }
  }
  return null;
}

export async function generateProfileByCountry(country, options = {}) {
  return generateRecord(resolveCountry(country), options);
}

export async function generateProfileByProxy(proxyUrl, options = {}) {
  outputFormat(options);
  const { apiKey = process.env.GOOGLE_API_KEY, timeoutMs = 15000, fetchImpl = fetch, proxyFetchImpl, signal } = options;
  if (!apiKey) throw new Error('Set GOOGLE_API_KEY in .env');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new InputError('timeoutMs must be an integer from 1 to 2147483647');
  if (typeof fetchImpl !== 'function') throw new InputError('fetchImpl must be a function');
  const location = await lookupProxyLocation(proxyUrl, { timeoutMs, signal, ...(proxyFetchImpl ? { fetchImpl: proxyFetchImpl } : {}) });
  if (!location) return null;
  const ipLocation = { state: location.state, rectangle: rectangleAround(location.latitude, location.longitude) };
  return generateRecord(location.country, options, ipLocation);
}
