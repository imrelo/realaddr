import { isIP } from 'node:net';
import { get } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { countryCode } from './countries.js';

const text = value => typeof value === 'string' ? value.trim() : '';
const coordinate = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) ? Number(value) : NaN;

// Small fetch-shaped adapter; node:https accepts standard Node proxy agents.
function proxyFetch(url, { agent, signal }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const request = get(url, { agent, signal }, response => {
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        body: { cancel: () => response.destroy() },
        async json() {
          const chunks = [];
          let size = 0;
          for await (const chunk of response) {
            size += chunk.length;
            if (size > 1024 * 1024) {
              response.destroy();
              throw new Error('IP response too large');
            }
            chunks.push(chunk);
          }
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        },
      });
    });
    const abort = () => {
      request.destroy(signal.reason);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    request.once('close', () => signal.removeEventListener('abort', abort));
    request.on('error', reject);
  });
}

function normalize(data, provider) {
  const primary = provider === 'ipwho.is';
  if (primary && data?.success !== true) return null;
  const ip = text(data?.ip);
  const country = countryCode(primary ? data?.country_code : data?.country);
  const state = text(primary ? data?.region : data?.stateProv);
  const city = text(data?.city);
  const latitude = coordinate(primary ? data?.latitude : data?.ll?.[0]);
  const longitude = coordinate(primary ? data?.longitude : data?.ll?.[1]);
  if (!isIP(ip) || !country || !state || !city || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  return { ip, country, state, city, latitude, longitude, timezone: text(primary ? data?.timezone?.id : data?.timezone), provider };
}

/** Look up the proxy's exit IP and approximate location, without calling Google. */
export async function lookupProxyLocation(proxyUrl, { timeoutMs = 15000, signal, fetchImpl = proxyFetch } = {}) {
  let proxy;
  try {
    if (typeof proxyUrl !== 'string' || !proxyUrl.trim()) throw new Error();
    proxy = new URL(proxyUrl);
    if (!['http:', 'https:', 'socks5:', 'socks:'].includes(proxy.protocol) || !proxy.hostname || !['', '/'].includes(proxy.pathname) || proxy.search || proxy.hash) throw new Error();
    // Validate encoded credentials without including them in any error message.
    decodeURIComponent(proxy.username);
    decodeURIComponent(proxy.password);
  } catch {
    throw new TypeError('proxyUrl must be an HTTP/HTTPS or SOCKS5 proxy URL');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new TypeError('timeoutMs must be a positive integer <= 2147483647');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  signal?.throwIfAborted();
  // Preserve the existing remote-DNS behavior for both SOCKS5 URL spellings.
  const socks = proxy.protocol === 'socks5:' || proxy.protocol === 'socks:';
  if (socks) proxy.protocol = 'socks5h:';
  for (const provider of ['ipwho.is', 'geo.myip.link']) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const agent = socks
      ? new SocksProxyAgent(proxy, { timeout: timeoutMs, socketOptions: { signal: requestSignal } })
      : new HttpsProxyAgent(proxy, { signal: requestSignal });
    try {
      const response = await fetchImpl(`https://${provider}/`, {
        agent,
        redirect: 'error',
        signal: requestSignal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      const result = normalize(await response.json(), provider);
      requestSignal.throwIfAborted();
      if (result) return result;
    } catch {
      signal?.throwIfAborted();
    } finally {
      agent.destroy();
    }
  }
  return null;
}
