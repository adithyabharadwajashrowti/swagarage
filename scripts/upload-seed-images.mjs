// Uploads supabase/seed-images/*.jpg to the product-images bucket under seed/.
// Needs the SERVICE ROLE key, so run it only on your own machine:
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/upload-seed-images.mjs
// Never put the service role key in the web app or commit it.
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'seed-images');
const files = (await readdir(dir)).filter((f) => /^[a-z0-9-]+\.jpg$/.test(f));
let ok = 0;
for (const file of files) {
  const res = await fetch(`${url}/storage/v1/object/product-images/seed/${file}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'true',
      'Cache-Control': 'public, max-age=31536000',
    },
    body: await readFile(join(dir, file)),
  });
  if (res.ok) ok++;
  else console.error(file, res.status, await res.text());
}
console.log(`Uploaded ${ok}/${files.length} images`);
