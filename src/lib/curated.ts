// Hand-picked photos for the home page: the best-looking product in each place.
// Each pick falls back to an automatic choice if that product is hidden or missing.
import type { CatalogueProduct } from './types';

/** Category tile photo on the home page. */
export const CATEGORY_COVER: Record<string, string> = {
  'bags-backpacks': 'sg-bg-0287',
  'gadgets-tech': 'sg-gt-0247',
  'travel-accessories': 'sg-ta-0040',
  apparel: 'sg-ap-0057',
  'eco-friendly': 'sg-ec-0029',
  'desk-office': 'sg-do-0176',
  drinkware: 'sg-dw-0234',
  stationery: 'sg-st-0238',
  'home-kitchen': 'sg-hl-0230',
  trophies: 'sg-tr-0708',
  'gift-sets': 'sg-gs-0062',
};

/** The four photos in the hero collage. */
export const HERO = ['sg-bg-0287', 'sg-ec-0051', 'sg-gt-0246', 'sg-ta-0040'];

/** Two photos per "Shop by occasion" card. */
export const COLLECTION_COVER: Record<string, string[]> = {
  'new-arrivals': ['sg-ec-0028', 'sg-gs-0511'],
  'employee-welcome-kits': ['sg-bg-0287', 'sg-dw-0234'],
  'diwali-festive': ['sg-gs-0531', 'sg-hl-0230'],
  'premium-client-gifts': ['sg-gt-0265', 'sg-bg-0382'],
  'eco-friendly-gifts': ['sg-ec-0033', 'sg-st-0345'],
  travel: ['sg-ta-0030', 'sg-ta-0040'],
  'under-500': ['sg-ec-0010', 'sg-st-0332'],
};

/** Eco-Friendly also lists eco-material products from every other category. */
export const ECO_CATEGORY = 'eco-friendly';
export const ECO_COLLECTION = 'eco-friendly-gifts';
export function inCategory(p: CatalogueProduct, slug: string): boolean {
  return p.category.slug === slug || (slug === ECO_CATEGORY && p.collection_slugs.includes(ECO_COLLECTION));
}

export function bySku(products: CatalogueProduct[]): Map<string, CatalogueProduct> {
  return new Map(products.filter((p) => p.image_path).map((p) => [p.sku, p]));
}
