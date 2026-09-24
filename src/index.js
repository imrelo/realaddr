import { generateProfileByCountry } from './generator.js';

export { generateProfileByCountry, generateProfileByProxy, InputError, GoogleApiError } from './generator.js';
export { lookupProxyLocation } from './proxy-ip.js';

/** Capture per-client options without changing process.env or opening a server. */
export function createCountryProfileGenerator(options = {}) {
  const config = { ...options };
  return country => generateProfileByCountry(country, config);
}
