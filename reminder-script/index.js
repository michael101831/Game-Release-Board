// Runs on a GitHub Actions schedule (see ../.github/workflows/reminders.yml).
// Reads Firestore directly with a service account — this is a plain Node
// script running on GitHub's runners, not a Firebase Cloud Function, so
// none of this requires the Blaze plan. It plays the same role the
// Cloud Function's scheduled job played in the earlier version.

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

// ---------------------------------------------------------------
// Game catalog — keep this in sync with the copy in public/index.html.
// ---------------------------------------------------------------
const GAMES = [
  { id: 'fire-emblem-fortunes-weave', name: "Fire Emblem: Fortune's Weave", date: '2026-09-17', platform: 'Switch 2' },
  { id: 'control-resonant', name: 'Control Resonant', date: '2026-09-24', platform: 'PC, PS5, Xbox Series X' },
  { id: 'witcher-3-remastered', name: 'The Witcher 3: Wild Hunt — Remastered', date: '2026-09-29', platform: 'PC, PS5, Xbox Series X' },
  { id: 'modern-warfare-new', name: 'Call of Duty: Modern Warfare (2026)', date: null, platform: 'PC, PS5, Xbox Series X' },
  { id: 'gears-new', name: 'Gears (new entry)', date: null, platform: 'Xbox Series X, PC' },
  { id: 'gta-vi', name: 'Grand Theft Auto VI', date: '2026-11-19', platform: 'PS5, Xbox Series X|S' },
  { id: 'silent-hill-townfall', name: 'Silent Hill: Townfall', date: null, platform: 'PS5, PC' },
  { id: 'marvels-wolverine', name: "Marvel's Wolverine", date: null, platform: 'PS5' },
  { id: 'blood-of-dawnwalker', name: 'The Blood of Dawnwalker', date: null, platform: 'PC, PS5, Xbox Series X' }
];

function findGame(id) {
  return GAMES.find((g) => g.id === id);
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}

// ---------------------------------------------------------------
// Firebase Admin init — GOOGLE_APPLICATION_CREDENTIALS_JSON is the
// full service account key JSON, passed in as a GitHub Actions secret.
// ---------------------------------------------------------------
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

  const snap = await db.collection('bookmarks').where('notified', '==', false).get();
  console.log(`Found ${snap.size} unnotified bookmark(s) to check.`);

  let sent = 0;

  for (const docSnap of snap.docs) {
    const bookmark = docSnap.data();
    const game = findGame(bookmark.gameId);
    if (!game || !game.date) continue; // no confirmed date yet — nothing to check

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
