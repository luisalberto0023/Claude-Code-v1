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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
