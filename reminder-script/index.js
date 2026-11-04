// Runs on a GitHub Actions schedule (see ../.github/workflows/reminders.yml).
// Reads Firestore directly with a service account — this is a plain Node
// script running on GitHub's runners, not a Firebase Cloud Function, so
// none of this requires the Blaze plan.
//
// Game data comes from RAWG when that API answers, and from Steam when
// it doesn't. The resulting list is also published to Firestore so the
// site can show games during a RAWG outage. Bookmarks store their own
// name and date as well, so a reminder can still be sent after a game
// drops out of the current 40-game window.

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { buildCatalog } = require('./catalog');

function gamesById(games) {
  return new Map((games || []).map((game) => [String(game.id), game]));
}

function gameFromBookmark(bookmark) {
  if (!bookmark || !bookmark.name || !bookmark.date) return null;
  return {
    id: String(bookmark.gameId),
    name: bookmark.name,
    date: bookmark.date,
    platform: bookmark.platform || 'Platform TBA'
  };
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}

function initFirebase() {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON is not set.');
  }
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function buildTransporter() {
  const port = Number(process.env.SMTP_PORT || 465);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendReminderEmail(transporter, email, displayName, game, daysLeft) {
  const when = daysLeft === 0 ? 'today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  const subject = `${game.name} releases ${when}`;
  const text = `Hi ${displayName || 'there'},\n\n${game.name} (${game.platform}) is coming out ${when}.\n\n— Release Board`;
  const html = `
    <p>Hi ${displayName || 'there'},</p>
    <p><strong>${game.name}</strong> (${game.platform}) is coming out <strong>${when}</strong>.</p>
    <p style="color:#8b8f99;font-size:13px;">You're getting this because you bookmarked it on Release Board.</p>
  `;
  await transporter.sendMail({ from: process.env.FROM_EMAIL, to: email, subject, text, html });
}

async function main() {
  initFirebase();
  const db = admin.firestore();
  const auth = admin.auth();
  const transporter = buildTransporter();

  console.log('Fetching current game catalog...');
  let catalog = { source: 'none', games: [] };
  try {
    catalog = await buildCatalog({ apiKey: process.env.RAWG_API_KEY });
    console.log(`Loaded ${catalog.games.length} upcoming game(s) from ${catalog.source}.`);
  } catch (err) {
    console.error(`Live catalog unavailable: ${err.message}`);
  }

  if (catalog.games.length) {
    try {
      await db.collection('catalog').doc('upcoming').set({
        source: catalog.source,
        fetchedAt: catalog.fetchedAt,
        games: catalog.games
      });
      if (catalog.source === 'rawg') {
        await db.collection('catalog').doc('rawg').set({
          fetchedAt: catalog.fetchedAt,
          games: catalog.games
        });
      }
    } catch (err) {
      console.error(`Could not publish the catalog to Firestore: ${err.message}`);
    }
  }

  const games = gamesById(catalog.games);
  let rawgCache = new Map();
  if (catalog.source !== 'rawg') {
    const cached = await db.collection('catalog').doc('rawg').get();
    if (cached.exists) rawgCache = gamesById(cached.data().games);
    if (rawgCache.size) {
      console.log(`Using ${rawgCache.size} cached RAWG game(s) for older bookmarks.`);
    }
  }

  const snap = await db.collection('bookmarks').where('notified', '==', false).get();
  console.log(`Found ${snap.size} unnotified bookmark(s) to check.`);

  let sent = 0;
  let unresolved = 0;

  for (const docSnap of snap.docs) {
    const bookmark = docSnap.data();
    // Prefer a fresh catalog date, then the last RAWG snapshot, then the
    // name and date saved on the bookmark itself.
    const game = games.get(String(bookmark.gameId))
      || rawgCache.get(String(bookmark.gameId))
      || gameFromBookmark(bookmark);
    if (!game || !game.date) {
      unresolved += 1;
      console.warn(`Skipping bookmark ${docSnap.id}: no release date available for game ${bookmark.gameId}.`);
      continue;
    }

    const left = daysUntil(game.date);
    if (left === null || left < 0) continue;

    const userDoc = await db.collection('users').doc(bookmark.uid).get();
    const reminderDays = (userDoc.exists && userDoc.data().reminderDays) || 3;
    if (left > reminderDays) continue;

    let userRecord;
    try {
      userRecord = await auth.getUser(bookmark.uid);
    } catch (err) {
      console.warn(`Skipping bookmark ${docSnap.id}: no such auth user (${err.message}).`);
      continue;
    }

    try {
      await sendReminderEmail(transporter, userRecord.email, userRecord.displayName, game, left);
      await docSnap.ref.update({ notified: true });
      sent += 1;
      console.log(`Sent reminder for "${game.name}" to ${userRecord.email}`);
    } catch (err) {
      console.error(`Failed to email ${userRecord.email} about ${game.name}:`, err.message);
    }
  }

  console.log(`Done. Sent ${sent} reminder email(s).`);
  if (!catalog.games.length && !rawgCache.size && unresolved > 0) {
    throw new Error(`Could not resolve ${unresolved} bookmark(s) because no game catalog was available.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Reminder job failed:', err);
    process.exit(1);
  });
