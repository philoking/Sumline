/**
 * Place names to IANA time zones.
 *
 * Conversion itself is free — `Intl.DateTimeFormat` knows every zone — but
 * nothing in the platform maps "Sydney" or "LAX" to `Australia/Sydney`. That
 * table has to be bundled, because the app is expected to work with no
 * network at all, so it is curated rather than exhaustive: large cities, the
 * busiest airports, and every country by its capital.
 */

const US_ABBREVIATIONS: Record<string, string> = {
  est: 'America/New_York',
  edt: 'America/New_York',
  'eastern time': 'America/New_York',
  cst: 'America/Chicago',
  cdt: 'America/Chicago',
  'central time': 'America/Chicago',
  mst: 'America/Denver',
  mdt: 'America/Denver',
  'mountain time': 'America/Denver',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  'pacific time': 'America/Los_Angeles',
  akst: 'America/Anchorage',
  akdt: 'America/Anchorage',
  hst: 'Pacific/Honolulu',
};

const WORLD_ABBREVIATIONS: Record<string, string> = {
  utc: 'UTC',
  gmt: 'UTC',
  z: 'UTC',
  bst: 'Europe/London',
  cet: 'Europe/Paris',
  cest: 'Europe/Paris',
  eet: 'Europe/Athens',
  msk: 'Europe/Moscow',
  ist: 'Asia/Kolkata',
  jst: 'Asia/Tokyo',
  kst: 'Asia/Seoul',
  sgt: 'Asia/Singapore',
  hkt: 'Asia/Hong_Kong',
  aest: 'Australia/Sydney',
  aedt: 'Australia/Sydney',
  awst: 'Australia/Perth',
  acst: 'Australia/Adelaide',
  nzst: 'Pacific/Auckland',
  nzdt: 'Pacific/Auckland',
};

const CITIES: Record<string, string> = {
  // North America
  'new york': 'America/New_York', boston: 'America/New_York',
  philadelphia: 'America/New_York', atlanta: 'America/New_York',
  miami: 'America/New_York', washington: 'America/New_York',
  toronto: 'America/Toronto', montreal: 'America/Toronto',
  detroit: 'America/Detroit', chicago: 'America/Chicago',
  houston: 'America/Chicago', dallas: 'America/Chicago',
  austin: 'America/Chicago', minneapolis: 'America/Chicago',
  'new orleans': 'America/Chicago', 'mexico city': 'America/Mexico_City',
  winnipeg: 'America/Winnipeg', denver: 'America/Denver',
  'salt lake city': 'America/Denver', phoenix: 'America/Phoenix',
  calgary: 'America/Edmonton', edmonton: 'America/Edmonton',
  'los angeles': 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles',
  seattle: 'America/Los_Angeles', portland: 'America/Los_Angeles',
  'san diego': 'America/Los_Angeles', 'las vegas': 'America/Los_Angeles',
  vancouver: 'America/Vancouver', anchorage: 'America/Anchorage',
  honolulu: 'Pacific/Honolulu',
  // South America
  'sao paulo': 'America/Sao_Paulo', 'são paulo': 'America/Sao_Paulo',
  'rio de janeiro': 'America/Sao_Paulo', 'buenos aires': 'America/Argentina/Buenos_Aires',
  santiago: 'America/Santiago', lima: 'America/Lima',
  bogota: 'America/Bogota', caracas: 'America/Caracas',
  // Europe
  london: 'Europe/London', dublin: 'Europe/Dublin',
  lisbon: 'Europe/Lisbon', paris: 'Europe/Paris',
  madrid: 'Europe/Madrid', barcelona: 'Europe/Madrid',
  berlin: 'Europe/Berlin', munich: 'Europe/Berlin',
  frankfurt: 'Europe/Berlin', hamburg: 'Europe/Berlin',
  amsterdam: 'Europe/Amsterdam', brussels: 'Europe/Brussels',
  zurich: 'Europe/Zurich', geneva: 'Europe/Zurich',
  vienna: 'Europe/Vienna', prague: 'Europe/Prague',
  warsaw: 'Europe/Warsaw', budapest: 'Europe/Budapest',
  rome: 'Europe/Rome', milan: 'Europe/Rome',
  copenhagen: 'Europe/Copenhagen', oslo: 'Europe/Oslo',
  stockholm: 'Europe/Stockholm', helsinki: 'Europe/Helsinki',
  athens: 'Europe/Athens', istanbul: 'Europe/Istanbul',
  kyiv: 'Europe/Kyiv', kiev: 'Europe/Kyiv', moscow: 'Europe/Moscow',
  // Africa & Middle East
  cairo: 'Africa/Cairo', lagos: 'Africa/Lagos',
  nairobi: 'Africa/Nairobi', johannesburg: 'Africa/Johannesburg',
  'cape town': 'Africa/Johannesburg', casablanca: 'Africa/Casablanca',
  dubai: 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai',
  doha: 'Asia/Qatar', riyadh: 'Asia/Riyadh',
  'tel aviv': 'Asia/Jerusalem', jerusalem: 'Asia/Jerusalem',
  tehran: 'Asia/Tehran',
  // Asia
  karachi: 'Asia/Karachi', mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata',
  bangalore: 'Asia/Kolkata', chennai: 'Asia/Kolkata',
  colombo: 'Asia/Colombo', dhaka: 'Asia/Dhaka',
  bangkok: 'Asia/Bangkok', hanoi: 'Asia/Ho_Chi_Minh',
  'ho chi minh city': 'Asia/Ho_Chi_Minh', jakarta: 'Asia/Jakarta',
  singapore: 'Asia/Singapore', 'kuala lumpur': 'Asia/Kuala_Lumpur',
  manila: 'Asia/Manila', 'hong kong': 'Asia/Hong_Kong',
  taipei: 'Asia/Taipei', shanghai: 'Asia/Shanghai',
  beijing: 'Asia/Shanghai', shenzhen: 'Asia/Shanghai',
  seoul: 'Asia/Seoul', tokyo: 'Asia/Tokyo',
  osaka: 'Asia/Tokyo', kyoto: 'Asia/Tokyo',
  // Oceania
  perth: 'Australia/Perth', adelaide: 'Australia/Adelaide',
  darwin: 'Australia/Darwin', brisbane: 'Australia/Brisbane',
  sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne',
  canberra: 'Australia/Sydney', hobart: 'Australia/Hobart',
  auckland: 'Pacific/Auckland', wellington: 'Pacific/Auckland',
  fiji: 'Pacific/Fiji',
};

const COUNTRIES: Record<string, string> = {
  'united states': 'America/New_York', usa: 'America/New_York',
  us: 'America/New_York', canada: 'America/Toronto',
  mexico: 'America/Mexico_City', brazil: 'America/Sao_Paulo',
  argentina: 'America/Argentina/Buenos_Aires', chile: 'America/Santiago',
  'united kingdom': 'Europe/London', uk: 'Europe/London',
  england: 'Europe/London', ireland: 'Europe/Dublin',
  france: 'Europe/Paris', spain: 'Europe/Madrid',
  portugal: 'Europe/Lisbon', germany: 'Europe/Berlin',
  netherlands: 'Europe/Amsterdam', belgium: 'Europe/Brussels',
  switzerland: 'Europe/Zurich', austria: 'Europe/Vienna',
  italy: 'Europe/Rome', greece: 'Europe/Athens',
  poland: 'Europe/Warsaw', sweden: 'Europe/Stockholm',
  norway: 'Europe/Oslo', denmark: 'Europe/Copenhagen',
  finland: 'Europe/Helsinki', turkey: 'Europe/Istanbul',
  ukraine: 'Europe/Kyiv', russia: 'Europe/Moscow',
  egypt: 'Africa/Cairo', nigeria: 'Africa/Lagos',
  kenya: 'Africa/Nairobi', 'south africa': 'Africa/Johannesburg',
  morocco: 'Africa/Casablanca', uae: 'Asia/Dubai',
  qatar: 'Asia/Qatar', 'saudi arabia': 'Asia/Riyadh',
  israel: 'Asia/Jerusalem', iran: 'Asia/Tehran',
  pakistan: 'Asia/Karachi', india: 'Asia/Kolkata',
  'sri lanka': 'Asia/Colombo', bangladesh: 'Asia/Dhaka',
  thailand: 'Asia/Bangkok', vietnam: 'Asia/Ho_Chi_Minh',
  indonesia: 'Asia/Jakarta', malaysia: 'Asia/Kuala_Lumpur',
  philippines: 'Asia/Manila', china: 'Asia/Shanghai',
  taiwan: 'Asia/Taipei', 'south korea': 'Asia/Seoul',
  korea: 'Asia/Seoul', japan: 'Asia/Tokyo',
  australia: 'Australia/Sydney', 'new zealand': 'Pacific/Auckland',
};

const AIRPORTS: Record<string, string> = {
  jfk: 'America/New_York', lga: 'America/New_York', ewr: 'America/New_York',
  bos: 'America/New_York', iad: 'America/New_York', dca: 'America/New_York',
  atl: 'America/New_York', mia: 'America/New_York', mco: 'America/New_York',
  yyz: 'America/Toronto', ord: 'America/Chicago', mdw: 'America/Chicago',
  dfw: 'America/Chicago', iah: 'America/Chicago', aus: 'America/Chicago',
  msp: 'America/Chicago', mex: 'America/Mexico_City', den: 'America/Denver',
  slc: 'America/Denver', phx: 'America/Phoenix', yyc: 'America/Edmonton',
  lax: 'America/Los_Angeles', sfo: 'America/Los_Angeles',
  sea: 'America/Los_Angeles', pdx: 'America/Los_Angeles',
  san: 'America/Los_Angeles', las: 'America/Los_Angeles',
  yvr: 'America/Vancouver', hnl: 'Pacific/Honolulu',
  gru: 'America/Sao_Paulo', eze: 'America/Argentina/Buenos_Aires',
  scl: 'America/Santiago', bog: 'America/Bogota', lim: 'America/Lima',
  lhr: 'Europe/London', lgw: 'Europe/London', stn: 'Europe/London',
  dub: 'Europe/Dublin', lis: 'Europe/Lisbon', cdg: 'Europe/Paris',
  ory: 'Europe/Paris', mad: 'Europe/Madrid', bcn: 'Europe/Madrid',
  ber: 'Europe/Berlin', muc: 'Europe/Berlin', fra: 'Europe/Berlin',
  ams: 'Europe/Amsterdam', bru: 'Europe/Brussels', zrh: 'Europe/Zurich',
  gva: 'Europe/Zurich', vie: 'Europe/Vienna', prg: 'Europe/Prague',
  waw: 'Europe/Warsaw', fco: 'Europe/Rome', mxp: 'Europe/Rome',
  cph: 'Europe/Copenhagen', osl: 'Europe/Oslo', arn: 'Europe/Stockholm',
  hel: 'Europe/Helsinki', ath: 'Europe/Athens', ist: 'Europe/Istanbul',
  svo: 'Europe/Moscow', cai: 'Africa/Cairo', los: 'Africa/Lagos',
  nbo: 'Africa/Nairobi', jnb: 'Africa/Johannesburg', cpt: 'Africa/Johannesburg',
  dxb: 'Asia/Dubai', doh: 'Asia/Qatar', ruh: 'Asia/Riyadh',
  tlv: 'Asia/Jerusalem', khi: 'Asia/Karachi', bom: 'Asia/Kolkata',
  del: 'Asia/Kolkata', blr: 'Asia/Kolkata', cmb: 'Asia/Colombo',
  dac: 'Asia/Dhaka', bkk: 'Asia/Bangkok', sgn: 'Asia/Ho_Chi_Minh',
  cgk: 'Asia/Jakarta', sin: 'Asia/Singapore', kul: 'Asia/Kuala_Lumpur',
  mnl: 'Asia/Manila', hkg: 'Asia/Hong_Kong', tpe: 'Asia/Taipei',
  pvg: 'Asia/Shanghai', pek: 'Asia/Shanghai', icn: 'Asia/Seoul',
  nrt: 'Asia/Tokyo', hnd: 'Asia/Tokyo', kix: 'Asia/Tokyo',
  per: 'Australia/Perth', adl: 'Australia/Adelaide', bne: 'Australia/Brisbane',
  syd: 'Australia/Sydney', mel: 'Australia/Melbourne', akl: 'Pacific/Auckland',
};

/**
 * Resolves a place name, abbreviation, airport code or GMT offset to a zone.
 *
 * Airports are checked last: `IST` is both Istanbul's airport and India
 * Standard Time, and the abbreviation is the more likely reading.
 */
export function resolveZone(name: string): string | null {
  const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;

  const offset = /^(?:gmt|utc)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(key);
  if (offset) {
    // Etc/GMT zones invert the sign, so GMT+8 is Etc/GMT-8.
    const sign = offset[1] === '+' ? '-' : '+';
    return `Etc/GMT${sign}${Number(offset[2])}`;
  }

  return (
    US_ABBREVIATIONS[key] ??
    WORLD_ABBREVIATIONS[key] ??
    CITIES[key] ??
    COUNTRIES[key] ??
    AIRPORTS[key] ??
    null
  );
}

/** Minutes that `zone` is ahead of UTC at the given moment. */
export function zoneOffsetMinutes(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/**
 * Builds the instant at which a zone's wall clock reads the given time.
 *
 * The offset is applied twice: the first pass uses the offset at roughly the
 * right moment, the second corrects it if that landed on the other side of a
 * daylight-saving change.
 */
export function instantInZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): Date {
  const naive = Date.UTC(year, month, day, hour, minute);
  let stamp = naive - zoneOffsetMinutes(new Date(naive), zone) * 60_000;
  stamp = naive - zoneOffsetMinutes(new Date(stamp), zone) * 60_000;
  return new Date(stamp);
}

/** The wall-clock fields a zone shows at a given instant. */
export function wallClockIn(at: Date, zone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const offset = zoneOffsetMinutes(at, zone);
  const shifted = new Date(at.getTime() + offset * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}
