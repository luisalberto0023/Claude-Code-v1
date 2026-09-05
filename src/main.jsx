import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App.jsx'
import './index.css'

// The service worker precaches index.html and serves every navigation from
// cache, so without this the browser keeps showing the previously cached build
// and a deploy only appears some launch later. Importing the register module
// (rather than letting the plugin inject a bare registration script) is what
// activates registerType:'autoUpdate': it reloads the page as soon as the new
// worker takes control, so a deploy lands on the next launch.
//
// No-ops in the standalone/APK build, where the PWA plugin is disabled.
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    // A home-screen PWA can stay open for days; browsers only check for a new
    // worker on navigation, so poll hourly to pick up releases in between.
    if (!registration) return
    setInterval(() => { registration.update() }, 60 * 60 * 1000)
  },
})

// Online play is a lazy chunk, and a deploy replaces every hashed filename. A
// tab still running the previous build therefore asks for a chunk that no
// longer exists on the server, and the import dies with "Failed to fetch
// dynamically imported module" the first time you open Play Online. Reload to
// pick up the current build — once per session, so a genuine network outage
// can't turn into a reload loop.
window.addEventListener('vite:preloadError', (event) => {
  let alreadyReloaded = true
  try {
    alreadyReloaded = sessionStorage.getItem('nexus-grid:chunk-reload') === '1'
    if (!alreadyReloaded) sessionStorage.setItem('nexus-grid:chunk-reload', '1')
  } catch {
    // Storage can be unavailable (private mode); fall through and let the
    // error surface rather than risking a loop.
  }
  if (alreadyReloaded) return
  event.preventDefault()
  window.location.reload()
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
