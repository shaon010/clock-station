# Running Clock Dock on the Windows tablet

## One-time setup

1. **Install Node.js** (LTS) from nodejs.org.
2. Copy the whole `Clock Dock` folder onto the tablet.
3. Open a terminal in the folder and run:
   ```
   npm install
   ```
4. Drop adhan MP3s into `public\audio\` (see that folder's README).

## Run it

Double-click `scripts\start.bat`. It starts the server and opens the display
full-screen. Your phone can then edit everything at the URL shown on screen
(e.g. `http://192.168.x.x:8080/settings`).

Exit kiosk mode with **Alt+F4** (or **Ctrl+W**).

## Make it automatic on boot

- Press **Win+R**, type `shell:startup`, Enter.
- Put a **shortcut to `scripts\start.bat`** in that folder.
- Now the display comes up on its own every time the tablet powers on.

## Keep the screen on & accurate

- **Power:** Settings → System → Power → Screen/Sleep → **Never** (both).
  (The app also uses the browser Wake Lock, but the OS setting is the backstop.)
- **Time:** Settings → Time & language → Date & time → **Set time automatically ON**
  and **Sync now**. Prayer times are only as accurate as the tablet's clock — old
  tablets drift, so this matters. The display shows nothing special if the clock is
  right; if it looks wrong, sync it here.
- **Time zone:** set the tablet's time zone to the **same region as your prayer
  location**. Prayer times are shown in the tablet's local time zone, so a desk
  clock in Dhaka with location = Dhaka is correct. (Only matters if the tablet and
  the location are in different zones — unusual for a desk display.)

## More robust: run the server as a Windows service (optional)

The Startup shortcut is fine, but a service restarts the server after a crash and
before login. Using **nssm** (nssm.cc):

```
nssm install ClockDock "C:\Program Files\nodejs\node.exe" "C:\path\to\Clock Dock\server\server.js"
nssm set ClockDock AppDirectory "C:\path\to\Clock Dock"
nssm start ClockDock
```

Then `start.bat` only needs to launch the browser (the server is already up).

## Moving the server off the tablet later

Because the display only talks to the server over HTTP, you can run
`node server/server.js` on a Raspberry Pi / spare PC instead and point the
tablet's kiosk URL at that machine's IP (`http://<pi-ip>:8080/`). No code change.
