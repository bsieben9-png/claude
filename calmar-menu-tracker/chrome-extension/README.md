# Calmar Menu Tracker: Chrome extension

The same app as the claude.ai version, running entirely on your computer. Checks run from Chrome, so they don't use any Claude usage and can't hit a limit.

## Install (Windows 11, Chrome)
1. Right-click `Calmar Menu Tracker.zip` → **Extract All** and keep the folder somewhere permanent, like Documents. Chrome loads the extension from that folder, so don't delete or move it.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the extracted **Calmar Menu Tracker** folder.
5. Click the puzzle-piece icon in the toolbar and pin **Calmar Menu Tracker**. Clicking its icon opens the app.

On first install it loads a copy of the menu, change log, matched photos and your ratings from the claude.ai app, then checks the live menu.

## How it runs
- It checks the store at 8:52 AM, 4:20 PM and midnight (your computer's time) while Chrome is running. If Chrome was closed at one of those times, the missed check runs within a few minutes of Chrome starting.
- **Check now** in the app runs a check right away. It takes about 5 seconds, or about a minute when there are new products needing pictures or photo matches.
- A Chrome notification shows new products, price changes and watchlist alerts. Clicking it opens the app.
- Everything is stored in this Chrome profile only. The claude.ai app and this one don't share ratings, watchlist or photo choices.

To have Chrome keep running in the background after you close its windows (so checks still happen), turn on Chrome Settings → System → **Continue running background apps when Google Chrome is closed**.

## Updating
Replace the folder's files with the new version, then click the reload arrow on the extension's card in `chrome://extensions`. Your data stays.

## Files
- `app.html`, `app.js`: the app page (same code as the claude.ai page)
- `shim.js`: gives the page its database, backed by `chrome.storage.local`
- `engine.js`: the menu check, pictures and photo matcher (a JavaScript port of `engine.py`, tested to give identical results)
- `background.js`: schedule, Check now, notifications
- `seed.json` (in the download only): the starting copy of your data
