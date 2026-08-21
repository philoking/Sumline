/**
 * Currency symbols we accept in source text, mapped to ISO codes.
 *
 * Symbols are rewritten to codes during preprocessing rather than registered as
 * math.js unit aliases, because most of them are not valid identifiers.
 */
export const SYMBOL_TO_CODE: Record<string, string> = {
  $: 'USD',
  '€': 'EUR', // €
  '£': 'GBP', // £
  '¥': 'JPY', // ¥
  '₹': 'INR', // ₹
  '₩': 'KRW', // ₩
  '₽': 'RUB', // ₽
  '₺': 'TRY', // ₺
  '₴': 'UAH', // ₴
  '฿': 'THB', // ฿
  '₪': 'ILS', // ₪
  '₱': 'PHP', // ₱
  '₫': 'VND', // ₫
  '₾': 'GEL', // ₾
  'R$': 'BRL',
  'C$': 'CAD',
  'A$': 'AUD',
  'NZ$': 'NZD',
  'HK$': 'HKD',
  'S$': 'SGD',
  // Matched ahead of the bare '¥' below, which is JPY: `SYMBOLS_BY_LENGTH`
  // tries longest first, so `CN¥100` cannot be read as a yen amount.
  'CN¥': 'CNY',
  // `kr` is deliberately absent: it is ambiguous between SEK, NOK and DKK.
};

/** Preferred symbol when formatting an amount back out. */
export const CODE_TO_SYMBOL: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  INR: '₹',
  KRW: '₩',
  RUB: '₽',
  TRY: '₺',
  UAH: '₴',
  THB: '฿',
  ILS: '₪',
  PHP: '₱',
  VND: '₫',
  GEL: '₾',
  BRL: 'R$',
  CAD: 'C$',
  AUD: 'A$',
  NZD: 'NZ$',
  HKD: 'HK$',
  SGD: 'S$',
  // `CN¥`, not a bare `¥`: that symbol parses back as JPY, so an amount this
  // engine printed did not survive being pasted into a sheet, and came back
  // roughly twenty-one times wrong with nothing in the text to hint at it.
  // Same disambiguation the dollar family already uses above.
  CNY: 'CN¥',
};

/** Currencies conventionally written without decimal places. */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY',
  'KRW',
  'VND',
  'CLP',
  'ISK',
  'HUF',
]);

/**
 * ISO codes that collide with a built-in math.js unit and must not be
 * registered as currencies. `mol` is not a currency, but `MOL`-style lookups in
 * math.js are case-sensitive, so the practical collisions are few; we keep the
 * list explicit so a future rate provider adding a code cannot silently break
 * unit math.
 */
export const RESERVED_CODES = new Set(['CD', 'MOL', 'RAD', 'BAR', 'GON']);

/**
 * Symbols sorted longest-first so multi-character prefixes (`R$`, `NZ$`) are
 * matched before the bare `$`.
 */
export const SYMBOLS_BY_LENGTH = Object.keys(SYMBOL_TO_CODE).sort(
  (a, b) => b.length - a.length,
);
