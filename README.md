# realaddr

An ESM Node.js 22.12+ module that combines public addresses from Google Places with generated sample profile fields. It accepts an English country name or ISO country code, or separately a proxy URL. Each successful call returns one pipe-delimited line with ten nonempty fields:

```text
firstName|lastName|address|city|state|stateName|zip|phone|email|password
```

The address is a real public place returned by Google. The name, phone, email, and password are generated; they do not belong to the address owner. A generated phone number or email may happen to be assigned to someone, and neither is checked for availability.

## Install from GitHub

```bash
npm install github:imrelo/realaddr
```

You can also install from a local copy with `npm install /path/to/realaddr`. This package has not been published to npm.

## Module API

```js
import {
  generateProfileByCountry,
  generateProfileByProxy,
  lookupProxyLocation,
  createCountryProfileGenerator,
} from 'realaddr';

const byCountry = createCountryProfileGenerator({
  apiKey: process.env.GOOGLE_API_KEY,
  referer: process.env.GOOGLE_REFERER, // Optional, if your key requires it.
  timeoutMs: 15_000,
});

console.log(await byCountry('US'));
console.log(await generateProfileByCountry('United Kingdom', {
  apiKey: process.env.GOOGLE_API_KEY,
}));
console.log(await generateProfileByProxy('socks5://user:password@host:1080', {
  apiKey: process.env.GOOGLE_API_KEY,
}));
console.log(await lookupProxyLocation('http://user:password@host:8080'));
```

`generateProfileByCountry` and `generateProfileByProxy` return `Promise<string | null>`. The first accepts only an English country name or ISO-2/ISO-3 code, such as `United States`, `US`, or `USA`. It does not accept an IP address or Vietnamese country name. The country generator factory captures options without changing `process.env`. Importing the package loads the local name and country data but does not start a server or send requests.

`generateProfileByProxy` first looks up the proxy's exit IP and approximate location. It calls `ipwho.is` through the proxy, then `geo.myip.link` through the same proxy if the first response fails or lacks required data. Each provider is called at most once. If both fail, the function returns `null`. Google Places then searches within a roughly 40 × 40 km rectangle around the reported coordinates. For US results, the Google state name must match the state reported by the IP provider and must be one of the 48 contiguous states. Google requests go directly from Node.js, while the IP lookups go through the supplied proxy. A rotating proxy may yield a different exit IP for the fallback request; use a sticky session if consistency matters.

The proxy location is approximate. The returned address is a public place near that location, not an address associated with the IP owner, and may be in a neighboring city.

### Options

| Option | Default | Purpose |
|---|---|---|
| `apiKey` | `process.env.GOOGLE_API_KEY` | Places API (New) key. |
| `referer` | `process.env.GOOGLE_REFERER` | Optional Referer header for Google; an empty string omits it. |
| `timeoutMs` | `15000` | Per-request timeout in milliseconds. |
| `signal` | None | AbortSignal for the entire operation. |
| `fetchImpl` | `globalThis.fetch` | Google request implementation, mainly for testing. |
| `proxyFetchImpl` | Internal Node HTTPS adapter | Proxy lookup implementation for `generateProfileByProxy`, mainly for testing. |

An incomplete address or record gets up to three retries after the first attempt, for at most four Google requests. Once complete, it returns immediately. If still incomplete, it returns `null`. Google HTTP, network, configuration, timeout, and abort errors are returned to the caller without retrying. There is no Google address cache or global concurrency limiter. The caller controls concurrency.

### Proxy lookup on its own

```js
import { lookupProxyLocation } from 'realaddr';

const location = await lookupProxyLocation('socks5://user:password@host:1080', {
  timeoutMs: 10_000,
  signal: AbortSignal.timeout(25_000),
});
// { ip, country, state, city, latitude, longitude, timezone, provider } or null
```

The proxy URL may use `http://`, `https://`, `socks5://`, or `socks://` (SOCKS5). SOCKS4 is unsupported. SOCKS5 performs destination DNS resolution through the proxy. Special characters in proxy usernames and passwords must be encoded with `encodeURIComponent` for each part. `lookupProxyLocation` does not need a Google key. It returns `null` if both IP services fail, throws `TypeError` for invalid options, and propagates caller cancellation. Its optional `fetchImpl` must support Node's `agent` option when making real requests; native `fetch` ignores that option. The function uses `https-proxy-agent` and `socks-proxy-agent` without changing a global proxy setting.

IP lookup quotas still apply. The free `ipwho.is` endpoint currently documents 1,000 requests per day per client IP. See the [provider documentation](https://ipwhois.io/documentation) for the current terms.

## CLI and HTTP server

From the project directory:

```powershell
npm ci
Copy-Item .env.example .env
# Set GOOGLE_API_KEY in .env if it is not already configured.
npm start
```

Keep an existing `.env` rather than overwriting it. The Google Cloud project needs Places API (New), billing, and a key authorized for this API. Set `GOOGLE_REFERER` only if needed for your key's restrictions. `.env` is excluded from Git and the package. The module and installed CLI do not load `.env` automatically; the repository's npm scripts do.

The server listens on `127.0.0.1:3000` by default. It only accepts `GET /generate?country=US` (or another English country name/ISO code) and returns `text/plain`:

```powershell
curl.exe "http://127.0.0.1:3000/generate?country=US"
npm run --silent generate -- US
npm run --silent generate -- "United Kingdom"
```

The installed CLI is `npx realaddr US`. To embed the HTTP server:

```js
import { createCountryProfileServer } from 'realaddr/server';
import { createCountryProfileGenerator } from 'realaddr';

const app = createCountryProfileServer(createCountryProfileGenerator({
  apiKey: process.env.GOOGLE_API_KEY,
}));
app.listen(3000, '127.0.0.1');
```

The HTTP server and CLI expose country generation. The proxy generator is a module function. The server returns HTTP 200 with the literal line `null` when no complete record is found, HTTP 400 for invalid input, and HTTP 502 for configuration or Google failures. The CLI prints `null` for no result and exits with code 1 on an error.

## Data and limitations

- First and last names come from the user-provided UTF-8 files `src/firstname.txt` and `src/lastname.txt`. Both lists load once into memory; an entry is picked with a random O(1) index. Empty lines are dropped, but original spelling and case are retained. Restart the process after editing these files. Names are not matched to the country or Google address.
- Addresses are public libraries, museums, or hotels returned by Google Places. Required fields are street, city, state code, full state name, and postal code. The result's country must match the requested country. US results require a street number and one of the 48 contiguous states; Alaska, Hawaii, DC, Puerto Rico, and other territories are excluded. Countries without suitable state or postal fields may return `null`. These addresses are not verified residential or shipping addresses.
- `state` is Google's short state code; `stateName` is its full name, for example `CA|California`. The output removes pipes and line breaks within fields so it remains one line with ten columns.
- Phone numbers are generated and validated with `libphonenumber-js/max`. The returned `phone` is a national number without `+` and the calling country code. US area codes are chosen from the Google address's state using the `src/us-area-codes.json` snapshot from the [NANPA NPA database](https://reports.nanpa.com/public/npa_report.csv), dated 2026-09-23. US numbers match the state, not necessarily the city. Other countries are validated at country level. A valid format does not establish that a number is active, available, or able to receive messages.
- Email uses a normalized first and last name plus a six-character alphanumeric suffix containing both letters and digits. Its domain is chosen from `gmail.com`, `yahoo.com`, `outlook.com`, `hotmail.com`, `icloud.com`, `aol.com`, `live.com`, `msn.com`, `proton.me`, and `mail.com`. No mailbox is created or checked for availability.
- Passwords are 8–12 characters and contain uppercase, lowercase, digits, and special characters. Random choices use Node.js cryptographic randomness. No output field contains `|`.
- Country names and ISO codes are a compact snapshot of 250 entries from `i18n-iso-countries` 7.14.0 in `src/countries.json`. The module builds one in-memory lookup map. The source license is retained in `licenses/i18n-iso-countries.txt`. This snapshot and the US area-code snapshot require manual updates.

## Verification and license

```powershell
npm test
npm run verify:package
```

Tests use mocked providers and do not spend Google quota. `verify:package` creates and installs a temporary package offline, checks its contents for included credentials, and exercises its imports and CLI. Run `npm ci` first so dependencies are available in the npm cache. GitHub Actions runs tests and package verification on Linux and Windows with Node.js 22.12 and 24. There is no build or postinstall step.

The project is marked **UNLICENSED**: no permission to reuse the project code is granted. The country dataset retains its separate MIT license in `licenses/i18n-iso-countries.txt`. The name files were supplied by the project owner. Add `repository`, `bugs`, and `homepage` to `package.json` when the GitHub repository exists.

References: [Google Text Search](https://developers.google.com/maps/documentation/places/web-service/text-search), [Google address components](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places), [libphonenumber-js](https://github.com/catamphetamine/libphonenumber-js).
