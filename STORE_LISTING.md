# Chrome Web Store — submission guide

Copy‑paste material and a checklist for publishing **Quick Summary for YouTube™**. Fill
in the fields marked _(you provide)_.

---

## Listing fields

**Item name** (≤ 75 chars)
```
Quick Summary for YouTube™
```
*(Matches the manifest `name`. This uses the Chrome Web Store-sanctioned "for YouTube™"
compatibility form — keep the ™ symbol, and include the trademark attribution at the end
of the detailed description below.)*

**Summary / short description** (≤ 132 chars)
```
Summarize any YouTube video from a right-click, using YouTube's own 'Ask' AI. Requires 'Ask' (experimental, Premium).
```

**Category:** Productivity
**Language:** English

**Detailed description**
```
Summarize any YouTube video with a right-click — using YouTube's own AI.

Quick Summary for YouTube™ gets you a video's summary straight from a right-click on
its thumbnail, so you don't have to open the video. Instead of sending the transcript to
some other AI, it uses YouTube's OWN built-in "Ask" feature and shows you the summary
YouTube itself generates.

⚠️ REQUIRES YOUTUBE PREMIUM + "ASK"
This extension does not run its own AI. It depends entirely on YouTube's built-in
"Ask" tool — an experimental feature currently limited to YouTube Premium members and
still rolling out gradually. You must be signed in to YouTube, and "Ask" must be
available for your account and for the specific video. If it isn't (Shorts, live
streams, music, kids', or age-restricted videos often don't have it), the extension
can't summarize that video.

WHAT YOU CAN DO
• Right-click any thumbnail → get a summary card, without opening the video
• Press Alt+Shift+S on a video to summarize the one you're watching
• "Ask a question" — type anything about a video and get YouTube's answer
• Auto-summarize every watch page (optional), with instant cached summaries on return
• Keep YouTube's formatting — headings, bullets, and clickable timestamps that seek
  the player in place

HOW IT WORKS
When you summarize from a thumbnail, the video opens in a hidden, muted background
window. The extension runs YouTube's "Ask → Summarize" there, reads the finished
answer, closes the window, and shows it as a movable, resizable card on the page you
were already on. Summaries are cached locally so repeats are instant.

PRIVACY
Everything stays on your device. No analytics, no external servers, no third-party
data sharing — the only network activity is with YouTube itself, in your own session.

Not affiliated with, sponsored by, or endorsed by YouTube or Google. YouTube is a
trademark of Google LLC. Use of this trademark is subject to Google Permissions.
```

**Privacy policy URL** _(you provide)_ — host `PRIVACY.md` somewhere public (e.g. a
GitHub repo / GitHub Pages) and paste the URL. A privacy policy URL is **required**
because the extension uses permissions that can access user data.

**Support / homepage URL** _(you provide, optional)_

---

## Single purpose

```
Summarize YouTube videos, and answer questions about them, using YouTube's own
built-in "Ask" AI feature.
```

## Permission justifications

Paste one per field in the dashboard's **Privacy practices** tab.

| Item | Justification |
|---|---|
| `contextMenus` | Adds the "Quick Summary" right-click menu used to summarize a video or ask a question about it. |
| `scripting` | Injects the script that operates YouTube's built-in "Ask" panel — clicks "Ask," chooses the Summarize prompt or types the user's question, and reads the resulting answer. |
| `storage` | Saves the user's settings, the locally cached summaries, and the summary card's position on the device. |
| `tabs` | Opens a minimized, muted background YouTube window to run the "Ask" flow for a right-clicked thumbnail, detects when it has finished loading, mutes it, closes it afterward, and routes the result back to the originating tab. |
| Host permission `*://*.youtube.com/*` | The extension operates only on YouTube; it needs access to youtube.com pages to drive the "Ask" interface and read the summary it generates. |
| Remote code | **No.** All code is bundled in the package; nothing is loaded from a remote source. |

## Data usage disclosures

The extension stores summaries and settings **locally only** and transmits **no** user
data off the device. In the dashboard you can certify all three statements as true:

- ✅ I do not sell or transfer user data to third parties, apart from the approved use cases.
- ✅ I do not use or transfer user data for purposes unrelated to my item's single purpose.
- ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes.

Data collection categories: select **none** — the extension does not collect or
transmit personally identifiable information, web history, user activity, or website
content to the developer or any third party. (Summaries are cached on the user's own
device and never leave it.)

---

## Notes for reviewers (paste into the review notes field)

```
Testing this extension requires a YouTube account that has the experimental "Ask"
feature (currently limited to YouTube Premium members). Without "Ask," the extension
will correctly show an "Ask isn't available" message instead of a summary.

To test with an eligible account:
1. Sign in to YouTube in the browser.
2. Right-click any video thumbnail → "Quick Summary" → "Summarize this video."
   The extension opens the video in a minimized, muted background window, uses
   YouTube's own "Ask → Summarize" feature there, reads the answer, closes the window,
   and shows the summary as a card. (Opening a hidden background window is intentional
   and is how the thumbnail flow avoids interrupting the current page.)
3. On a watch page you can also press Alt+Shift+S, or use the right-click menu.

All data stays local (chrome.storage.local). The only network requests are to
youtube.com within the user's own session.
```

---

## Required assets

| Asset | Spec | Status |
|---|---|---|
| Store icon | 128×128 PNG | ✅ `icons/icon128.png` |
| Screenshots | 1280×800 or 640×400, 1–5 images | ⬜ _(you provide — see below)_ |
| Small promo tile | 440×280 PNG | ⬜ optional |
| Marquee promo | 1400×560 PNG | ⬜ optional |

**Suggested screenshots** (capture on a video that has “Ask”):
1. A summary card open over a YouTube page after right‑clicking a thumbnail.
2. The right‑click **Quick Summary** submenu (Summarize / Ask a question).
3. The **Ask a question** dialog with a typed question.
4. The embedded summary card on a watch page (return visit / auto‑summarize).
5. The toolbar popup showing the settings.

---

## Packaging the upload

Build the ZIP with the included packager. It bundles only the runtime files
(`manifest.json`, `src/`, `icons/`) with the forward-slash paths Chrome requires:

```bash
python tools/package.py
```

This writes `quick-summary-for-youtube.zip`, ready to upload in the Developer Dashboard.

Alternative (Bash, with the `zip` tool installed):
```bash
zip -r quick-summary-for-youtube.zip manifest.json src icons
```

> ⚠️ **Avoid Windows PowerShell's `Compress-Archive` for this.** The default Windows
> PowerShell (5.1) writes ZIP entries with backslashes (`src\background.js`), which can
> make the Chrome Web Store reject the package or fail to find `manifest.json`. Use
> `python tools/package.py` instead.

What the package includes / excludes:
- **Include:** `manifest.json`, `src/`, `icons/`
- **Exclude:** `.idea/`, `tools/`, `*.md`, `.gitignore`, any `*.zip`

---

## Pre‑submission checklist

- [ ] `manifest.json` version is correct (currently **1.0.0**).
- [ ] Loaded unpacked and tested: thumbnail summarize, Alt+Shift+S, Ask a question,
      auto‑summarize, clear cache, reset card.
- [ ] Tested the no‑“Ask” path (graceful "unavailable" card).
- [ ] Privacy policy hosted and URL ready.
- [ ] Screenshots captured (1–5).
- [ ] Permission justifications and single‑purpose pasted.
- [ ] Data‑usage certifications completed.
- [ ] Reviewer notes pasted (explains the Premium requirement + background window).
- [ ] ZIP built from the include list above.
