# Release Board — Firebase Spark plan + GitHub Actions

No backend, no Blaze. Accounts and bookmarks run entirely on Firebase's free Spark plan
(Firebase Authentication + Firestore, called directly from the browser); reminder emails
are sent by a small script on a GitHub Actions schedule instead of a Cloud Function.

## How it fits together

```
Browser
  → yourproject.web.app         (Firebase Hosting serves public/index.html)
  → Firebase Auth                (sign up / sign in, directly from the browser)
  → Firestore                    (bookmarks + reminder preference, directly from the browser,
                                   locked down by firestore.rules to each user's own data)

GitHub Actions (daily, or run manually)
  → reminder-script/index.js     (reads Firestore with a service account, sends email via SMTP)
```

Nothing here is a Cloud Function, so nothing requires the Blaze plan.

## One-time setup

### 1. Create the Firebase project
At https://console.firebase.google.com. Spark (free) plan is fine — don't upgrade.

### 2. Turn on Email/Password sign-in
Firebase console → Build → Authentication → Sign-in method → enable **Email/Password**.

### 3. Turn on Firestore
Firebase console → Build → Firestore Database → Create database. Any region works;
start in production mode (the included `firestore.rules` already locks it down correctly).

### 4. Get your web app config
Firebase console → Project settings → General → scroll to "Your apps" → add a **Web** app
→ copy the `firebaseConfig` object it gives you.

Open `public/index.html`, find the `firebaseConfig` object near the top of the
`<script type="module">` block, and paste your real values in. This object isn't a
secret — it's meant to be public. Firestore Security Rules are what actually protect
your data, not hiding these values.

### 5. Install the CLI, log in, and link the project
```bash
npm install -g firebase-tools
firebase login
cp .firebaserc.example .firebaserc
```
Edit `.firebaserc` and replace `your-firebase-project-id` with your real project ID.

### 6. Deploy Hosting + Firestore rules
```bash
firebase deploy --only hosting,firestore
```
Firebase prints your live URL (`https://your-project-id.web.app`) when it's done. At this
point accounts and bookmarks already work — try it.

### 7. Set up the GitHub Actions reminder job
1. Generate a service account key: Firebase console → Project settings → Service accounts
   → **Generate new private key**. This downloads a JSON file — keep it private, never
   commit it.
2. In your GitHub repo: Settings → Secrets and variables → Actions → **New repository
   secret**, and add each of these:
   - `GOOGLE_APPLICATION_CREDENTIALS_JSON` — paste the *entire contents* of that JSON file
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL` — same as any SMTP
     setup (a Gmail App Password or a Resend API key both work fine)
3. That's it — `.github/workflows/reminders.yml` is already in the repo and will start
   running on its daily schedule once you push.

## Connecting GitHub for auto-deploy on push

Two more workflow files are already in `.github/workflows/`:
- `firebase-hosting-merge.yml` — deploys to your live site every time you push to `main`
- `firebase-hosting-pull-request.yml` — deploys a temporary preview URL for each pull
  request (and comments the link on the PR), without touching the live site

Both need a `FIREBASE_SERVICE_ACCOUNT` secret and your real project ID:

1. **Create a service account for deploys.** Google Cloud console → IAM & Admin → Service
   Accounts → Create Service Account. Give it the **Firebase Hosting Admin** role — that's
   all deploying Hosting needs. (This is deliberately a separate account from the one you
   made for the reminder script, which needs Firestore/Auth access instead — keeping them
   separate means each one only has the access it actually needs.)
2. On that service account, go to **Keys → Add key → Create new key → JSON** to download
   the key file.
3. In your GitHub repo: Settings → Secrets and variables → Actions → **New repository
   secret** → name it `FIREBASE_SERVICE_ACCOUNT`, and paste the entire contents of that
   JSON file.
4. In both `firebase-hosting-merge.yml` and `firebase-hosting-pull-request.yml`, replace
   `your-firebase-project-id` with your real project ID.
5. Push this project to a new GitHub repo the normal way:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```

That push itself will trigger `firebase-hosting-merge.yml` and deploy the site — check the
**Actions** tab in GitHub to watch it run. From then on, every push to `main` redeploys
automatically, the same as your other projects.

(If you'd rather have the Firebase CLI generate all of this for you interactively instead
of doing it by hand, `firebase init hosting:github` — run locally, logged into both the
Firebase and GitHub CLIs — does the same setup and creates the secret for you. The files
above are the same output that command would produce, done manually so you can review
exactly what permissions are being granted before pushing.)

## Testing the reminder job without waiting for the schedule

Go to your repo's **Actions** tab → "Send release reminders" → **Run workflow**. This
uses the same `workflow_dispatch` trigger already in the workflow file.

To test locally instead:
```bash
cd reminder-script
npm install
npm install dotenv
cp .env.example .env   # fill in real values
node -r dotenv/config index.js
```

Since none of the sample games are within their reminder window on a typical day, you
won't see an actual email send unless a bookmarked game's date is close — or you
temporarily edit a date in `reminder-script/index.js` (and the matching entry in
`public/index.html`) to something near-future to test the full flow.

## Testing locally with the emulators

```bash
firebase emulators:start
```
Runs Hosting, Firestore, and Auth emulators together at `http://localhost:5000`. Data in
the emulator doesn't persist between runs — that's expected, it's for throwaway testing.

## Why this needed a real rewrite, not just removing email

Cloud Functions for Firebase — both 1st and 2nd gen — requires the Blaze plan for *any*
function, not just ones that send email or run on a schedule. Since the previous version's
entire backend (auth, bookmarks, account settings) ran as a Cloud Function, there was no
way to keep that architecture and drop Blaze. This version removes Cloud Functions
entirely: Firebase Auth and the Firestore client SDK replace the custom Express routes,
and GitHub Actions replaces the scheduled function.

## Security note

`firestore.rules` is the only thing gating access now, since the browser talks to
Firestore directly (there's no server in between checking who's asking). Each rule
checks the signed-in user's Firebase Auth uid against the document being read or written,
so a user can only ever touch their own `users/{uid}` doc and their own bookmarks. The
reminder script's service account bypasses these rules entirely (as Admin SDK access
always does), which is expected and fine — it's the trusted, non-public side.
