// Uploads every .jpg in a folder to the product-images bucket under <prefix>/.
// Needs the SERVICE ROLE key, so run it only on your own machine:
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/upload-images.mjs <folder> <prefix>
// Example (new catalogue photos): node scripts/upload-images.mjs ../swagarage-private/images/catalogue catalogue
// Never put the service role key in the web app or commit it. Safe to re-run: files are overwritten.
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const [dirArg, prefix] = process.argv.slice(2);
if (!url || !key || !dirArg || !prefix || !/^[a-z0-9-]+$/.test(prefix)) {
  console.error('Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/upload-images.mjs <folder> <prefix>');
  process.exit(1);
}
const dir = resolve(dirArg);
const files = (await readdir(dir)).filter((f) => /^[a-z0-9-]+\.jpg$/.test(f));
let ok = 0;
let failed = 0;
const upload = async (file) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${url}/storage/v1/object/product-images/${prefix}/${file}`, {
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
      if (res.ok) return void ok++;
      if (attempt === 3) console.error(file, res.status, await res.text());
    } catch (e) {
      if (attempt === 3) console.error(file, String(e));
    }
  }
  failed++;
};
// Five at a time: quick, without tripping rate limits.
for (let i = 0; i < files.length; i += 5) {
  await Promise.all(files.slice(i, i + 5).map(upload));
  if (i % 100 === 0) console.log(`${Math.min(i + 5, files.length)}/${files.length}`);
}
console.log(`Uploaded ${ok}/${files.length} images${failed ? `, ${failed} failed (re-run to retry)` : ''}`);
