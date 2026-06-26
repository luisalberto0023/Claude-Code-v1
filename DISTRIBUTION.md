# Distributing Nexus Grid to testers

The game is a self-contained web app. There are three ways to get it onto
testers' phones, from least to most effort.

---

## 1. Single HTML file (instant, zero setup)

`nexus-grid.html` is the whole game inlined into one file (only needs internet
once, to load the Google Fonts).

- Build it: `npm run build:standalone`
- Share the file directly (chat, email, Drive). Testers open it in any browser.

Good for: quick "try it now" feedback. Not an install.

---

## 2. Installable PWA — live on GitHub Pages (recommended for tester rounds)

**Live URL:** https://luisalberto0023.github.io/Claude-Code-v1/

Every push to the game branch auto-deploys this via
`.github/workflows/pages.yml`. Share the link — it works in any browser,
including **iOS Safari**, where testers can add it to the Home Screen for an
app-like, offline experience (the interim iOS solution until a native build).

To host it elsewhere instead, build and deploy `dist/`:

```bash
npm run build      # outputs dist/ with manifest + service worker
```

Then deploy `dist/` to any static host (all free tiers work):

- **Netlify**: drag the `dist/` folder onto https://app.netlify.com/drop
- **GitHub Pages**: push `dist/` to a `gh-pages` branch
- **Vercel**: `vercel deploy dist`

Send testers the URL → on Android Chrome they'll get an "Install app" prompt
(or ⋮ menu → *Add to Home screen*); on iOS Safari, Share → *Add to Home Screen*.

---

## 3. Native Android APK (a real installable file to sideload)

A [Capacitor](https://capacitorjs.com) project wraps the web build in a native
Android WebView. The assets are bundled inside, so it runs fully offline.

### Easiest: build it in the cloud (no Android Studio needed)

A GitHub Actions workflow (`.github/workflows/android-apk.yml`) builds a
**debug APK** automatically:

1. Push to the `dots-and-boxes-mini-game-app` branch (or run the workflow
   manually from the **Actions** tab → *Build Android APK* → *Run workflow*).
2. Open the finished run → **Artifacts** → download `nexus-grid-debug-apk`.
3. Send the `app-debug.apk` to testers.

Testers install it by opening the file and allowing
*Settings → Install unknown apps* for their browser/Files app.

> Debug APKs are signed with a throwaway debug key — fine for testing, **not**
> for the Play Store.

### Build it locally instead

Requires Android Studio (or the Android SDK) + JDK 21.

```bash
npm run build              # or: STANDALONE=1 npx vite build
npx cap sync android
cd android
./gradlew assembleDebug    # APK at app/build/outputs/apk/debug/app-debug.apk
```

Or open the `android/` folder in Android Studio and Run on a device/emulator.

---

## Going to the Play Store later

When you're ready for a real release:

1. Generate an upload keystore and configure signing in `android/app`.
2. Build a release bundle: `./gradlew bundleRelease` → produces an `.aab`.
3. Create a Play Console app and upload to the **Internal testing** track —
   testers install via a Play Store link, with proper update management.

---

## Regenerating icons

Source artwork lives in `build-assets/`. Icons were rendered with headless
Chromium (no native image deps):

```bash
npm i --no-save playwright-core
node build-assets/gen-icons.mjs          # PWA icons -> public/icons/
node build-assets/gen-android-icons.mjs  # launcher icons -> android/.../res/mipmap-*
```

App identity (name/id) is in `capacitor.config.json`
(`appId: com.nexusgrid.app`).
