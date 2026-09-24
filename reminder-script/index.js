// Runs on a GitHub Actions schedule (see ../.github/workflows/reminders.yml).
// Reads Firestore directly with a service account — this is a plain Node
// script running on GitHub's runners, not a Firebase Cloud Function, so
// none of this requires the Blaze plan.
//
// Game data comes live from RAWG (same source as the frontend), keyed by
// RAWG's own numeric id — so there's no hand-maintained list to keep in
// sync between the site and this script anymore.

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const RAWG_LOOKAHEAD_DAYS = 180;

async function fetchGamesFromRAWG() {
  const apiKey = process.env.RAWG_API_KEY;
  if (!apiKey) throw new Error('RAWG_API_KEY is not set.');

  const today = new Date();
  const end = new Date(today.getTime() + RAWG_LOOKAHEAD_DAYS * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url = `https://api.rawg.io/api/games?key=${apiKey}&dates=${fmt(today)},${fmt(end)}&ordering=released&page_size=40&exclude_additions=true`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`RAWG responded with ${res.status}`);
  const data = await res.json();

  const games = new Map();
  (data.results || [])
    .filter((g) => g.released)
    .forEach((g) => {
      games.set(String(g.id), {
        id: String(g.id),
        name: g.name,
        date: g.released,
        platform: (g.platforms || []).slice(0, 3).map((p) => p.platform.name).join(', ') || 'Platform TBA'
      });
    });
  return games;
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

  console.log('Fetching current game catalog from RAWG...');
  const games = await fetchGamesFromRAWG();
  console.log(`Loaded ${games.size} upcoming game(s) from RAWG.`);

  const snap = await db.collection('bookmarks').where('notified', '==', false).get();
  console.log(`Found ${snap.size} unnotified bookmark(s) to check.`);

  let sent = 0;

  for (const docSnap of snap.docs) {
    const bookmark = docSnap.data();
    const game = games.get(bookmark.gameId);
    // A game a user bookmarked may have since dropped out of RAWG's
    // lookahead window (e.g. it already released) — nothing to check then.
    if (!game || !game.date) continue;

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
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Reminder job failed:', err);
    process.exit(1);
  });
