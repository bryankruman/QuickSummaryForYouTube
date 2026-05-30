# Privacy Policy — Quick Summary for YouTube™

**Last updated: May 29, 2026**

Quick Summary for YouTube™ ("the extension") is designed to keep all of your data on your own
device. It has no servers, no analytics, and no third‑party data sharing.

## Summary

- The extension **does not collect, transmit, or sell any personal data.**
- Everything it saves stays **locally in your browser** (`chrome.storage.local`).
- The only network activity is with **YouTube itself**, inside your own signed‑in
  session — the same requests your browser already makes when you use YouTube.

## What the extension stores locally

All of the following is kept on your device only and is never sent anywhere by the
extension:

| Stored item | Purpose |
|---|---|
| Cached summaries (`ytsum_summaries`) | So a video you've already summarized appears instantly. Holds the summary text/HTML and the video title; capped to the most recent 200 and removable at any time. |
| Auto‑summarize setting (`ytsum_autoSummarize`) | Remembers whether you turned on auto‑summarize. |
| Card position & size (`ytsum_popup`) | Remembers where you moved/resized the summary card. |

You can erase the cached summaries at any time with **Clear cached summaries** in the
popup, and remove everything by uninstalling the extension.

## What the extension accesses

- **YouTube pages you visit.** To produce a summary, the extension reads and interacts
  with the YouTube page (it clicks YouTube's “Ask” button, chooses a summarize prompt
  or types your question, and reads the answer YouTube generates). This happens only on
  `youtube.com`.
- **A hidden background window.** When you summarize from a thumbnail, the extension
  briefly opens the video in a minimized, muted YouTube window to run the “Ask” flow,
  then closes it.
- **Video titles.** To label the summary card, the extension may request a video's
  public title from YouTube's public oEmbed endpoint (`youtube.com/oembed`). This is an
  unauthenticated, public request to YouTube.

## What the extension does **not** do

- It does **not** send your summaries, questions, browsing activity, or any other data
  to the developer or to any third party.
- It does **not** use analytics, tracking, advertising, or fingerprinting.
- It does **not** include any remote or externally hosted code.
- It does **not** sell or share your data with anyone.

## Third‑party services

The extension relies on **YouTube's** own built‑in “Ask” feature, operated by Google.
Any interaction with YouTube — including the summaries “Ask” generates — is governed by
[Google's Privacy Policy](https://policies.google.com/privacy) and YouTube's Terms of
Service. Quick Summary for YouTube™ is an independent project and is not affiliated with YouTube
or Google.

## Changes to this policy

If this policy changes, the updated version will be published with the extension and
the "Last updated" date above will change.

## Contact

Questions about this policy can be sent to the developer through the extension's Chrome
Web Store support page.
