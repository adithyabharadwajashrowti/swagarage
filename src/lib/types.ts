// Row shapes used by the app. They mirror supabase/migrations.
// For full generated types run: npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts

export type UserRole = 'client' | 'staff' | 'admin';
export type ProductStatus = 'draft' | 'review' | 'live' | 'archived';
export type PriceBasis = 'mrp' | 'gst_extra' | 'on_request';
export type ProofreadStatus = 'unchecked' | 'ok' | 'fixed' | 'remove';
export type LogoAction = 'keep' | 'replace' | 'none';
export type QuoteStatus = 'submitted' | 'in_review' | 'quoted' | 'won' | 'lost' | 'cancelled';

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  company: string | null;
  phone: string | null;
  role: UserRole;
  created_at: string;
}

export interface Category {
  id: number;
  slug: string;
  name: string;
  sort_order: number;
}

export interface Collection {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
}

export interface Product {
  id: string;
  sku: string;
  slug: string;
  name: string;
  brand: string | null;
  category_id: number;
  subcategory: string | null;
  description: string | null;
  features: string[];
  specs: Record<string, string>;
  colours: string[];
  image_path: string | null;
  mrp: number | null;
  sell_price: number | null;
  price_basis: PriceBasis;
  moq: number;
  branding_possible: boolean;
  delivery_note: string | null;
  ready_stock: number | null;
  under_production: boolean;
  status: ProductStatus;
  updated_at: string;
  /** GST % added at checkout (from the vendor price list; 18 if unknown). */
  gst_rate?: number;
  /** Gift boxes and similar: offered on the quote page, not listed in the shop. */
  is_addon?: boolean;
}

/** Product as loaded for the storefront, with its category and collection slugs. */
export interface CatalogueProduct extends Product {
  category: Pick<Category, 'id' | 'slug' | 'name'>;
  collection_slugs: string[];
}

export interface Quote {
  id: string;
  ref: string;
  user_id: string;
  status: QuoteStatus;
  contact_name: string;
  company: string;
  email: string;
  phone: string | null;
  occasion: string | null;
  delivery_city: string | null;
  needed_by: string | null;
  notes: string | null;
  estimate_total: number;
  quoted_total: number | null;
  created_at: string;
  updated_at: string;
}

export interface QuoteItem {
  id: string;
  quote_id: string;
  product_id: string | null;
  product_sku: string;
  product_name: string;
  quantity: number;
  unit_price: number | null;
  price_basis: PriceBasis;
  colour: string | null;
  branding: string | null;
}

export interface QuoteEvent {
  id: number;
  quote_id: string;
  actor_id: string | null;
  from_status: QuoteStatus | null;
  to_status: QuoteStatus;
  message: string | null;
  created_at: string;
}

export interface Vendor {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
}

export interface VendorOffer {
  id: string;
  product_id: string;
  vendor_id: string;
  vendor_sku: string | null;
  cost_price: number | null;
  vendor_mrp: number | null;
  vendor_moq: number | null;
  stock: Record<string, Record<string, number | string>>;
  last_checked: string | null;
}

export interface ProductInternal {
  product_id: string;
  source_ref: string | null;
  data_origin: string | null;
  proofread_status: ProofreadStatus;
  logo_action: LogoAction;
  notes: string | null;
}

export interface PricingRule {
  category_id: number;
  margin_pct: number;
}

export interface AuditEntry {
  id: number;
  actor_id: string | null;
  action: string;
  table_name: string;
  row_id: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  created_at: string;
}
