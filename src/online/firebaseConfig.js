/* ──────────────────────────────────────────────────────────────────────────
   Firebase configuration for online multiplayer.

   These keys are MEANT to be public — a Firebase web config is not a secret.
   Access is controlled by Firestore security rules (see ONLINE_MULTIPLAYER.md),
   not by hiding these values.

   To enable online play:
   1. Create a free project at https://console.firebase.google.com
   2. Add a Web App, enable Firestore Database.
   3. Paste the config object's values below (replace the REPLACE_ME_* values).
   4. Deploy the rules in firestore.rules.

   Until real values are filled in, the "Play Online" button shows a
   "needs setup" state and never tries to connect — so the rest of the game is
   unaffected.
   ────────────────────────────────────────────────────────────────────────── */

export const firebaseConfig = {
  apiKey: 'REPLACE_ME_API_KEY',
  authDomain: 'REPLACE_ME_PROJECT.firebaseapp.com',
  projectId: 'REPLACE_ME_PROJECT',
  storageBucket: 'REPLACE_ME_PROJECT.appspot.com',
  messagingSenderId: 'REPLACE_ME_SENDER_ID',
  appId: 'REPLACE_ME_APP_ID',
};

export function isOnlineConfigured() {
  return !Object.values(firebaseConfig).some(v => typeof v === 'string' && v.startsWith('REPLACE_ME'));
}
