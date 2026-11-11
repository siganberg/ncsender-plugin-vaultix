# ncSender Vaultix Sync Plugin

> **IMPORTANT DISCLAIMER:** This plugin is part of my personal ncSender project. If you choose to use it, you do so entirely at your own risk. I am not responsible for any damage, malfunction, or personal injury that may result from the use or misuse of this plugin. Use it with caution and at your own discretion.

Keeps a folder of your [Vaultix](https://github.com/siganberg/vaultix) cloud drive in step with the ncSender file manager on a kiosk. Save G-code to your drive from any computer and it is on the machine a minute later; files made on the kiosk go back up to the drive.

## What you need

- An ncSender kiosk running ncSender Pro **2.0.316** or newer, or ncSender **2.0.225** or newer.
- A Vaultix server the kiosk can reach. Vaultix is a free cloud drive you run yourself, on a computer you already have or on a NAS; [its page](https://github.com/siganberg/vaultix) has the download and setup steps.

On a desktop computer you don't need this plugin: install the [Vaultix app](https://github.com/siganberg/vaultix/releases/latest) and choose ncSender's file folder as its sync folder. The plugin shows that folder's path when you open it on a desktop.

## Setting it up

1. Install **Vaultix Sync** from the Plugins tab and open it from the Tools tab.
2. **Sign in** with your server address, username and password. If your account uses two-factor authentication, type the 6-digit code (or a recovery code) when asked. An app password from Vaultix (Settings → Devices & app passwords) also works and skips the code.
3. **Pick a folder.** Only that folder and its subfolders sync.

The password is used once and never stored. The kiosk keeps a device token instead; it is listed as "ncSender kiosk" under Devices in Vaultix, where you can revoke it.

## How sync works

- Synced files live in a `Vaultix` folder in the ncSender file manager.
- Only G-code and laser files sync: `.nc`, `.gcode`, `.gc`, `.g`, `.gco`, `.ngc`, `.ncc`, `.tap`, `.cnc`.
- It checks every minute, and waits while a job is running. **Sync now** checks straight away.
- A new or changed file on either side is copied to the other.
- A file changed in both places keeps both copies; the kiosk's copy is saved as `name (conflict kiosk <date>).nc`.
- A file deleted on Vaultix is removed from the kiosk.
- A file deleted on the kiosk stays on Vaultix and is not downloaded again unless it changes there.
- If the Vaultix folder suddenly looks empty, nothing is removed from the kiosk.

The plugin talks to Vaultix over WebDAV, plus the Vaultix sign-in for the device token.

## Development

`commands.js` is the sync engine and runs in ncSender's plugin engine; `config.html` is the window. Tests run the engine against an in-memory server:

```bash
node --test tests/sync.test.cjs
```

## License

GPL-3.0 — see [LICENSE-GPL-3.0](./LICENSE-GPL-3.0).
