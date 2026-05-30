# Quick Summary for YouTube™

Get a YouTube video's summary from a **right‑click on its thumbnail** — powered by
YouTube's *own* built‑in **“Ask”** AI, so you never have to open the video.

Unlike typical "YouTube summary" extensions (which send the transcript to *their* own
LLM), Quick Summary for YouTube™ drives YouTube's native **Ask → Summarize** flow and reads the
answer back. The summary you see is the one YouTube itself generates.

> ### ⚠️ Requires YouTube Premium + the experimental “Ask” feature
> This extension does **not** run its own AI. It relies entirely on YouTube's built‑in
> **“Ask”** tool, which is an **experimental feature currently limited to YouTube
> Premium members** and is still rolling out gradually.
>
> If your account doesn't have “Ask,” or a particular video doesn't offer it (Shorts,
> live streams, music, kids', or age‑restricted videos often don't), the extension
> can't produce a summary for that video. You also need to be **signed in to YouTube**
> in your browser.

---

## Features

- **Right‑click any thumbnail → summary.** The video opens in a hidden, muted
  background window, YouTube's “Ask” flow runs there, and the result appears as a
  movable, resizable card on the page you were already on — without interrupting what
  you're watching.
- **Summarize the current video.** On a watch page, press **Alt+Shift+S** or use the
  right‑click menu.
- **Ask a question.** Pick **“Ask a question”** from the right‑click menu, type
  anything about the video, and the extension routes it through YouTube's “Ask” box
  and shows the answer in the same card.
- **Auto‑summarize (opt‑in).** Turn it on in the popup and every watch page is
  summarized as it loads; revisits show your saved summary instantly.
- **Instant repeats.** Summaries are cached locally, so re‑summarizing a video you've
  already done is immediate — no background tab, no waiting.
- **Formatting preserved.** Headings, bullets, bold and clickable timestamps from
  YouTube's answer are kept; timestamps seek the player in place.

## How it works

1. You trigger a summary (right‑click a thumbnail, the keyboard shortcut, the
   right‑click menu, or auto‑summarize).
2. For a thumbnail, the extension opens that video in a **minimized, muted background
   window** so nothing plays out loud and your current tab is untouched. For a video
   you're already on, it runs in place.
3. It clicks YouTube's **“Ask”** button, chooses a **Summarize** prompt (or types your
   question), and waits for YouTube's answer to finish streaming.
4. It reads the finished answer out of the panel, closes the background window, and
   shows the summary as a card. The result is cached so the next request is instant.

Everything happens inside your own signed‑in YouTube session, in your browser. No
transcripts, prompts, or summaries are ever sent to any third‑party server. See
[PRIVACY.md](PRIVACY.md).

## Install

### From the Chrome Web Store
*(Link will be added once the listing is published.)*

### Load unpacked (developers)
1. Open `chrome://extensions` and enable **Developer mode** (top‑right).
2. Click **Load unpacked** and select this project folder.
3. Sign in to the YouTube account that has the “Ask” feature, then try a right‑click on
   a thumbnail.

## Usage

- **From a thumbnail (anywhere on YouTube):** right‑click → **Quick Summary** →
  **Summarize this video** (a card appears) or **Ask a question** (type a question, get
  an answer) — without opening the video.
- **On a watch page:** press **Alt+Shift+S**, or right‑click → **Quick Summary** →
  **Summarize this video** / **Ask a question**.
- **Auto‑summarize:** open the toolbar popup and enable **Auto‑summarize videos**.
  - First visit to a video: YouTube's own **Ask → Summarize** panel opens in place and
    the extension quietly caches the result.
  - Return visits: the cached summary appears instantly as the extension's card,
    embedded where YouTube's “Ask” card sits. An **Ask** button on that card opens
    YouTube's real Ask panel.
  - Toggle it off anytime — it takes effect immediately, no reload.

The summary card can be **dragged** by its title bar and **resized** from any corner;
its position and size are remembered. Use **Reset popup size & location** in the popup
to restore the default.

## Permissions

The extension requests only what it needs, and nothing leaves your device:

| Permission | Why |
|---|---|
| `contextMenus` | Adds the **Quick Summary** right‑click menu. |
| `scripting` | Runs the script that drives YouTube's “Ask” UI on the target tab. |
| `storage` | Saves your settings, cached summaries, and the card's position locally. |
| `tabs` | Opens the muted background window, waits for it to load, and routes the result back to the right tab. |
| `host_permissions: *://*.youtube.com/*` | The extension only operates on YouTube. |

It uses no analytics, no external servers, and no remote code.

## Settings & storage

- **Auto‑summarize videos** — summarize each watch page as it loads (default: off).
- **Clear cached summaries** — wipe all saved summaries.
- **Reset popup size & location** — restore the summary card to its default
  top‑right position and size.

All of this is stored with `chrome.storage.local` on your machine.

## Known limitations

- **Depends on YouTube's rollout.** “Ask” is experimental and Premium‑gated; if it
  isn't available for your account or a given video, there's nothing the extension can
  do. When that happens, the card explains the likely reasons.
- **Heuristic selectors.** The “Ask” UI is an unreleased experiment, so the extension
  finds its buttons and answer by visible text and structure. If YouTube changes that
  UI, the extension may need an update.
- **Background‑tab throttling** can slow the hidden‑window path; timeouts are generous
  (a summary typically takes a few seconds while it waits for the full answer).

## Disclaimer

Quick Summary for YouTube™ is an independent project. It is **not affiliated with,
sponsored by, or endorsed by YouTube or Google.** YouTube is a trademark of Google LLC.
Use of this trademark is subject to Google Permissions. The extension automates
YouTube's own interface within your signed‑in session; please use it for personal,
low‑volume use in accordance with YouTube's Terms of Service.

## Development

| Path | Role |
|---|---|
| `manifest.json` | MV3 manifest: permissions, content script, command, icons |
| `src/background.js` | Service worker: context menus, shortcut, orchestration, summary cache, and the injected `askDriver` (summarize **or** ask) |
| `src/content.js` | Renders the floating result card, the embedded watch‑page card, and the “Ask a question” dialog; handles auto‑summarize |
| `src/overlay.css` | Styling for the floating card, the embedded card, and the ask dialog |
| `src/popup.html` / `src/popup.js` | Toolbar popup: auto‑summarize toggle, clear cached summaries, reset card position |
| `icons/icon{16,32,48,128}.png` | Sparkle toolbar/store icons |
| `tools/gen_icons.py` | Regenerates the icons (pure Python standard library, no dependencies) |
| `tools/package.py` | Builds the Chrome Web Store upload ZIP (`quick-summary-for-youtube.zip`) |

Regenerate icons with `python tools/gen_icons.py`. Build the store ZIP with
`python tools/package.py` — see [STORE_LISTING.md](STORE_LISTING.md) for the full
submission checklist (listing copy, permission justifications, screenshots).
