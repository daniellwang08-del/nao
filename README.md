# NAO browser extension

The Chrome extension for [NAO](https://nao.it.com): tailored resumes, application
autofill, auto-apply and the job assistant side panel. The web app and API live
in a separate repository; this one holds only the extension.

## Install

1. Download [`nao-extension.zip`](https://github.com/daniellwang08-del/nao/releases/latest/download/nao-extension.zip)
   (latest release) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped `nao-extension` folder.
4. Pin **NAO** and sign in with your NAO account.

To update, download the new zip, replace the folder, and click the reload icon
on the NAO card in `chrome://extensions`. The extension ID is fixed by the
`key` in `manifest.json`, so sign-in and settings carry over.

## Develop

Load this repository folder itself with **Load unpacked**; reload the card after
edits. The default server is `https://nao.it.com` (`config.js`); the Settings
view can point the extension at another server, such as a local API on
`http://127.0.0.1:8000`.

```bash
npm test          # node:test suites in test/
npm run package   # dist/nao-extension.zip with only the files Chrome loads
```

No dependencies to install; Node 20.15 or newer is enough.

## Release

Bump `version` in `manifest.json` and push to `main`. CI runs the tests and,
when no release exists for that version yet, publishes `v<version>` with
`nao-extension.zip` attached. The web app's install dialog links to
`releases/latest/download/nao-extension.zip`, so users always get the newest build.

## Server contract

The extension talks to the NAO API (`/api/v1/...`) and to the web app through
`content/webapp-bridge.js`. When changing either side, keep them compatible:
`CONNECT_BUILD` in `src/jobSiteConnect.js` must match the web app's
`frontend/src/lib/extensionBridge.ts`, and comments that cite `app/...` paths
refer to the web app repository.
