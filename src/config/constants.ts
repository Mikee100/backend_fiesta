export const SERVICE_DURATIONS: Record<string, number> = {
  'bloom': 90,
  'the bloom': 90,
  'muse': 120,
  'the muse': 120,
  'icon': 150,
  'the icon': 150,
  'legend': 150,
  'the legend': 150,
  'queen': 180,
  'the queen': 180,
  'empress': 210,
  'the empress': 210,
  'goddess': 300,
  'the goddess': 300,
  // Legacy fallbacks
  'standard': 90,
  'economy': 120,
  'executive': 150,
  'gold': 150,
  'platinum': 150,
  'vip': 210,
  'vvip': 210
};

export const DEFAULT_DURATION = 120;

/** Current Editions 2026 + legacy names for extraction / matching */
export const PACKAGE_NAME_PATTERN =
  'bloom|muse|icon|legend|queen|empress|goddess|standard|economy|executive|gold|platinum|vip|vvip';

export const PACKAGE_NAMES_FOR_EXTRACTION = [
  'THE BLOOM', 'THE MUSE', 'THE ICON', 'THE LEGEND',
  'THE QUEEN', 'THE EMPRESS', 'THE GODDESS',
] as const;

/** Priced optional add-ons (settle with balance — not included in deposit) */
export interface AddonCatalogItem {
  sku: string;
  name: string;
  unitPrice: number; // KSH; 0 = quoted / variable
  match: RegExp;
  quantityFromNote?: boolean;
}

export const ADDON_CATALOG: AddonCatalogItem[] = [
  {
    sku: 'extra_edited_photo',
    name: 'Extra edited photo',
    unitPrice: 1000,
    match: /extra\s+edited\s+photo|extra\s+photo(?!\s*book)/i,
    quantityFromNote: true,
  },
  {
    sku: 'extra_digital_art',
    name: 'Extra digital art edit',
    unitPrice: 3000,
    match: /digital\s+art|extra\s+art\s+edit/i,
    quantityFromNote: true,
  },
  {
    sku: 'extra_outfit',
    name: 'Extra outfit beyond package',
    unitPrice: 4000,
    match: /extra\s+outfit/i,
    quantityFromNote: true,
  },
  {
    sku: 'extra_makeup',
    name: 'Extra professional makeup',
    unitPrice: 3500,
    match: /extra\s+(professional\s+)?makeup/i,
  },
  {
    sku: 'power_suit',
    name: 'Fiesta House Power Suit',
    unitPrice: 10000,
    match: /power\s+suit/i,
  },
  {
    sku: 'wig_hire',
    name: 'Styled wig hire',
    unitPrice: 4000,
    match: /wig\s+hire|styled\s+wig|hire\s+(a\s+)?wig/i,
    quantityFromNote: true,
  },
  {
    sku: 'wig_styling',
    name: 'Wig styling only',
    unitPrice: 3000,
    match: /wig\s+styling/i,
    quantityFromNote: true,
  },
  {
    sku: 'suspending_concept',
    name: 'Suspending Concept',
    unitPrice: 7000,
    match: /suspending\s+concept/i,
  },
  {
    sku: 'sculpture_set',
    name: 'Goddess Sculpture Set',
    unitPrice: 15000,
    match: /sculpture\s+set|goddess\s+sculpture/i,
  },
  {
    sku: 'professional_reel',
    name: 'Professional Reel',
    unitPrice: 0,
    match: /professional\s+reel|\breel\b/i,
  },
  {
    sku: 'raw_files',
    name: 'Raw files',
    unitPrice: 0,
    match: /raw\s+files?/i,
  },
];
