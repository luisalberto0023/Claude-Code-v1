# Online multiplayer setup (≈5 minutes)

Nexus Grid online play uses **Firebase Firestore** as a tiny serverless relay.
The app stays static (GitHub Pages / APK) — Firebase is the only backend, and
there's no server to run. Until you add your Firebase keys, the **Play Online**
button shows a "needs setup" message and the rest of the game is unaffected.

## 1. Create a Firebase project

1. Go to https://console.firebase.google.com → **Add project** (any name).
   The free **Spark** plan is plenty for testers.
2. In the project, open **Build → Firestore Database → Create database**.
   Start in **production mode** (we'll add rules in step 3), pick a region.

## 2. Register a Web App and copy the config

1. Project Overview → the **`</>` (Web)** icon → register an app (nickname any).
2. Firebase shows a `firebaseConfig` object. Copy those values into
   **`src/online/firebaseConfig.js`**, replacing each `REPLACE_ME_*`:

   ```js
   export const firebaseConfig = {
     apiKey: '…',
     authDomain: '….firebaseapp.com',
     projectId: '…',
     storageBucket: '….appspot.com',
     messagingSenderId: '…',
     appId: '…',
   };
   ```

   > These keys are **not secrets** — a Firebase web config is meant to be
   > public. Access is controlled by the rules in step 3.

## 3. Deploy the security rules

In the console: **Firestore Database → Rules**, paste the contents of
**`firestore.rules`** from this repo, and **Publish**.

(v1 rules allow open read/write to the `rooms` collection — fine for friendly
play. The file includes a commented hardened version that requires Anonymous
Auth once you want it.)

## 4. Ship it

Commit the edited `firebaseConfig.js` and push. CI rebuilds:

- the **web** site (https://luisalberto0023.github.io/Claude-Code-v1/)
- the **APK** (release `android-debug`)

Now **Play Online → Create match** gives a 4-letter room code; your opponent
picks **Join** and enters it. Moves sync in real time.

## How it works

- One Firestore document per match in `rooms/{CODE}`.
- The full game state is stored as a JSON string and rewritten on each move
  (the game is turn-based, so this is tiny and simple).
- Both devices subscribe with `onSnapshot` and render from the synced state.
- Host = Player 1 (cyan), guest = Player 2 (crimson). The board only accepts
  input on your turn.

## Scope / limitations (v1)

- **Classic mode**, 2 human players, **private room codes**.
- Blitz timer, power-ups, and random matchmaking are not yet wired for online
  (they have extra sync edge cases) — natural next additions.
- Client-authoritative: good for friendly play, not cheat-proof. Add the
  hardened rules + server validation for competitive use.
- Online play requires the **hosted site or the APK** — not the single-file
  `nexus-grid.html` (which is for offline local play).
