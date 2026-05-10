// Static ISO 3166-1 alpha-2 → English-name map. See
// docs/superpowers/specs/2026-05-10-place-country-design.md for why we ship
// a map instead of using `Intl.DisplayNames` (Hermes support not guaranteed
// on RN 0.83 / Expo 55). English-only for v1; revisit if the app gains
// other locales.

// Europe — Western & Northern.
const europeWest: Record<string, string> = {
  GB: 'United Kingdom',
  IE: 'Ireland',
  FR: 'France',
  DE: 'Germany',
  NL: 'Netherlands',
  BE: 'Belgium',
  LU: 'Luxembourg',
  CH: 'Switzerland',
  AT: 'Austria',
  LI: 'Liechtenstein',
  MC: 'Monaco',
  AD: 'Andorra',
  ES: 'Spain',
  PT: 'Portugal',
  IT: 'Italy',
  SM: 'San Marino',
  VA: 'Vatican City',
  MT: 'Malta',
  DK: 'Denmark',
  NO: 'Norway',
  SE: 'Sweden',
  FI: 'Finland',
  IS: 'Iceland',
};

// Europe — Eastern & Southeastern.
const europeEast: Record<string, string> = {
  PL: 'Poland',
  CZ: 'Czechia',
  SK: 'Slovakia',
  HU: 'Hungary',
  RO: 'Romania',
  BG: 'Bulgaria',
  HR: 'Croatia',
  SI: 'Slovenia',
  RS: 'Serbia',
  BA: 'Bosnia and Herzegovina',
  ME: 'Montenegro',
  MK: 'North Macedonia',
  AL: 'Albania',
  GR: 'Greece',
  CY: 'Cyprus',
  EE: 'Estonia',
  LV: 'Latvia',
  LT: 'Lithuania',
  BY: 'Belarus',
  UA: 'Ukraine',
  MD: 'Moldova',
  RU: 'Russia',
};

// Asia — East & South-East.
const asiaEast: Record<string, string> = {
  JP: 'Japan',
  KR: 'South Korea',
  KP: 'North Korea',
  CN: 'China',
  HK: 'Hong Kong',
  MO: 'Macao',
  MN: 'Mongolia',
  TW: 'Taiwan',
  VN: 'Vietnam',
  TH: 'Thailand',
  LA: 'Laos',
  KH: 'Cambodia',
  MM: 'Myanmar',
  MY: 'Malaysia',
  SG: 'Singapore',
  ID: 'Indonesia',
  PH: 'Philippines',
  BN: 'Brunei',
  TL: 'Timor-Leste',
};

// Asia — South & Central.
const asiaSouth: Record<string, string> = {
  IN: 'India',
  PK: 'Pakistan',
  BD: 'Bangladesh',
  LK: 'Sri Lanka',
  NP: 'Nepal',
  BT: 'Bhutan',
  MV: 'Maldives',
  AF: 'Afghanistan',
  KZ: 'Kazakhstan',
  KG: 'Kyrgyzstan',
  TJ: 'Tajikistan',
  TM: 'Turkmenistan',
  UZ: 'Uzbekistan',
};

// Middle East / West Asia.
const middleEast: Record<string, string> = {
  TR: 'Turkey',
  IL: 'Israel',
  PS: 'Palestine',
  JO: 'Jordan',
  LB: 'Lebanon',
  SY: 'Syria',
  IQ: 'Iraq',
  IR: 'Iran',
  SA: 'Saudi Arabia',
  AE: 'United Arab Emirates',
  QA: 'Qatar',
  BH: 'Bahrain',
  KW: 'Kuwait',
  OM: 'Oman',
  YE: 'Yemen',
  AM: 'Armenia',
  AZ: 'Azerbaijan',
  GE: 'Georgia',
};

// Africa.
const africa: Record<string, string> = {
  EG: 'Egypt',
  LY: 'Libya',
  TN: 'Tunisia',
  DZ: 'Algeria',
  MA: 'Morocco',
  EH: 'Western Sahara',
  MR: 'Mauritania',
  SN: 'Senegal',
  GM: 'Gambia',
  GW: 'Guinea-Bissau',
  GN: 'Guinea',
  SL: 'Sierra Leone',
  LR: 'Liberia',
  CI: 'Côte d’Ivoire',
  GH: 'Ghana',
  TG: 'Togo',
  BJ: 'Benin',
  NG: 'Nigeria',
  CM: 'Cameroon',
  CF: 'Central African Republic',
  TD: 'Chad',
  ML: 'Mali',
  BF: 'Burkina Faso',
  NE: 'Niger',
  SD: 'Sudan',
  SS: 'South Sudan',
  ET: 'Ethiopia',
  ER: 'Eritrea',
  DJ: 'Djibouti',
  SO: 'Somalia',
  KE: 'Kenya',
  UG: 'Uganda',
  RW: 'Rwanda',
  BI: 'Burundi',
  TZ: 'Tanzania',
  MW: 'Malawi',
  ZM: 'Zambia',
  ZW: 'Zimbabwe',
  MZ: 'Mozambique',
  MG: 'Madagascar',
  KM: 'Comoros',
  MU: 'Mauritius',
  SC: 'Seychelles',
  AO: 'Angola',
  CD: 'DR Congo',
  CG: 'Republic of the Congo',
  GA: 'Gabon',
  GQ: 'Equatorial Guinea',
  ST: 'São Tomé and Príncipe',
  CV: 'Cape Verde',
  ZA: 'South Africa',
  NA: 'Namibia',
  BW: 'Botswana',
  LS: 'Lesotho',
  SZ: 'Eswatini',
};

// Americas — North & Central.
const americasNorth: Record<string, string> = {
  US: 'United States',
  CA: 'Canada',
  MX: 'Mexico',
  GT: 'Guatemala',
  BZ: 'Belize',
  SV: 'El Salvador',
  HN: 'Honduras',
  NI: 'Nicaragua',
  CR: 'Costa Rica',
  PA: 'Panama',
};

// Caribbean.
const caribbean: Record<string, string> = {
  CU: 'Cuba',
  JM: 'Jamaica',
  HT: 'Haiti',
  DO: 'Dominican Republic',
  PR: 'Puerto Rico',
  TT: 'Trinidad and Tobago',
  BB: 'Barbados',
  BS: 'Bahamas',
  AG: 'Antigua and Barbuda',
  DM: 'Dominica',
  GD: 'Grenada',
  KN: 'Saint Kitts and Nevis',
  LC: 'Saint Lucia',
  VC: 'Saint Vincent and the Grenadines',
  AW: 'Aruba',
  CW: 'Curaçao',
  KY: 'Cayman Islands',
  BM: 'Bermuda',
  TC: 'Turks and Caicos Islands',
  VG: 'British Virgin Islands',
  VI: 'U.S. Virgin Islands',
  AI: 'Anguilla',
  MS: 'Montserrat',
  GP: 'Guadeloupe',
  MQ: 'Martinique',
};

// South America.
const southAmerica: Record<string, string> = {
  AR: 'Argentina',
  BR: 'Brazil',
  CL: 'Chile',
  CO: 'Colombia',
  PE: 'Peru',
  EC: 'Ecuador',
  BO: 'Bolivia',
  PY: 'Paraguay',
  UY: 'Uruguay',
  VE: 'Venezuela',
  GY: 'Guyana',
  SR: 'Suriname',
  GF: 'French Guiana',
};

// Oceania.
const oceania: Record<string, string> = {
  AU: 'Australia',
  NZ: 'New Zealand',
  PG: 'Papua New Guinea',
  FJ: 'Fiji',
  SB: 'Solomon Islands',
  VU: 'Vanuatu',
  NC: 'New Caledonia',
  PF: 'French Polynesia',
  WS: 'Samoa',
  TO: 'Tonga',
  KI: 'Kiribati',
  TV: 'Tuvalu',
  NR: 'Nauru',
  PW: 'Palau',
  MH: 'Marshall Islands',
  FM: 'Micronesia',
  CK: 'Cook Islands',
  NU: 'Niue',
  GU: 'Guam',
  MP: 'Northern Mariana Islands',
  AS: 'American Samoa',
};

export const COUNTRY_NAMES: Record<string, string> = {
  ...europeWest,
  ...europeEast,
  ...asiaEast,
  ...asiaSouth,
  ...middleEast,
  ...africa,
  ...americasNorth,
  ...caribbean,
  ...southAmerica,
  ...oceania,
};

/**
 * Resolve an ISO-2 code to its English name. Falls back to the raw code
 * if missing (defensive — every code we expect to see is mapped, but a
 * fallback keeps the UI from breaking on stale rows).
 *
 * Empty / null input returns null so callers can branch on "no signal".
 */
export function displayCountry(code: string | null | undefined): string | null {
  if (!code) return null;
  return COUNTRY_NAMES[code] ?? code;
}
