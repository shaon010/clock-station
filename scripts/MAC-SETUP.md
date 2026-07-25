# Running Clock Dock on a Mac

## One-time setup

1. **Install Node.js** (LTS) from nodejs.org, if not already installed.
2. Open a terminal in this folder and run:
   ```
   npm install
   ```
3. Drop adhan MP3s into `public/audio/` (see that folder's README).

## Run it

Double-click `scripts/start-mac.sh` (or run it from a terminal). It starts the
server and opens the display in Chrome **kiosk mode** — full screen, no
address bar. Your phone can then edit everything at the URL shown on screen
(e.g. `http://192.168.x.x:8080/settings`).

Exit kiosk mode with **Cmd+Q**.

### Why kiosk mode, not the in-page fullscreen button

The on-screen fullscreen button (⛶) uses the browser's Fullscreen API, which
always exits on a real page reload — including the "Reload display" button in
Settings. That's a browser security rule, not something a page can override.
`--kiosk` makes fullscreen a property of the Chrome *window* instead, so a
remote reload just refreshes the page in place without ever leaving
fullscreen. Once you're running via `start-mac.sh`, you can ignore the ⛶
button.

## Make it automatic on login

- **System Settings → General → Login Items** → click **+** under
  "Open at Login" → add `scripts/start-mac.sh`.
- Now the display comes up on its own every time the Mac logs in.

## Keep the screen on & accurate

- **Power:** System Settings → Lock Screen → set "Turn display off" to
  **Never** (or run `caffeinate -d` alongside the server). The app also uses
  the browser Wake Lock, but the OS setting is the backstop.
- **Time:** System Settings → General → Date & Time → **Set time and date
  automatically ON**. Prayer times are only as accurate as the Mac's clock.
- **Time zone:** set the Mac's time zone to the **same region as your prayer
  location**. Prayer times are shown in local time, so a desk clock in Dhaka
  with location = Dhaka is correct. (Only matters if the Mac and the location
  are in different zones — unusual for a desk display.)

## More robust: run the server as a background service (optional)

The Login Items shortcut is fine, but a `launchd` service restarts the server
after a crash and keeps it running independent of any user session:

```xml
<!-- ~/Library/LaunchAgents/com.clockdock.server.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.clockdock.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/Clock Dock/server/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/Clock Dock</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/com.clockdock.server.plist`.
Then `start-mac.sh` only needs to launch the browser (comment out the "start
the server" block, or just point Login Items at a kiosk-launch-only script).

## Moving the server off this Mac later

Because the display only talks to the server over HTTP, you can run
`node server/server.js` on a Raspberry Pi / spare machine instead and point
the kiosk URL at that machine's IP (`http://<ip>:8080/`). No code change.
