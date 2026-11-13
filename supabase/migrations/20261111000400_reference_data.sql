-- Reference data the app relies on: categories and occasion collections.
insert into public.categories (slug, name, sort_order) values
  ('bags-backpacks',       'Bags & Backpacks',     1),
  ('gadgets-tech',         'Gadgets & Tech',       2),
  ('travel-accessories',   'Travel & Accessories', 3),
  ('apparel',              'Apparel',              4),
  ('eco-friendly',         'Eco-Friendly',         5),
  ('desk-office',          'Desk & Office',        6)
on conflict (slug) do nothing;

insert into public.collections (slug, name, description, sort_order) values
  ('employee-welcome-kits', 'Employee Welcome Kits', 'Laptop bags, tech and desk gear for day one', 1),
  ('diwali-festive',        'Diwali & Festive',      'Speakers, lamps and gifts for the season',   2),
  ('premium-client-gifts',  'Premium Client Gifts',  'Leather, smartwatches and statement pieces', 3),
  ('eco-friendly-gifts',    'Eco-Friendly Gifts',    'Plantable, cork, bamboo, jute and recycled', 4),
  ('travel',                'Travel',                'Duffles, slings, passport and travel kits',  5),
  ('under-500',             'Under ₹500',            'Thoughtful gifts that go easy on budgets',   6)
on conflict (slug) do nothing;
