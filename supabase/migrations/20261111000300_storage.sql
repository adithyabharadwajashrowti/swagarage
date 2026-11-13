-- Product images bucket: public read (images are shown on the storefront),
-- only staff may upload, replace or delete. 2 MB limit, images only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 2097152,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy product_images_staff_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and (select public.is_staff()));

create policy product_images_staff_update on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images' and (select public.is_staff()))
  with check (bucket_id = 'product-images' and (select public.is_staff()));

create policy product_images_staff_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and (select public.is_staff()));
