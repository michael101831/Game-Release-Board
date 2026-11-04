// Writes public/catalog.json so the site can show games even when the
// browser cannot reach RAWG. The reminder job refreshes a newer copy in
// Firestore; this file is the copy shipped with the site.

const fs = require('fs');
const path = require('path');
const { buildCatalog } = require('./catalog');

async function main() {
  const catalog = await buildCatalog({ apiKey: process.env.RAWG_API_KEY });
  const out = path.join(__dirname, '..', 'public', 'catalog.json');
  fs.writeFileSync(out, JSON.stringify(catalog));
  console.log(`Wrote ${catalog.games.length} ${catalog.source} game(s) to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
