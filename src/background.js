// background.js — MV3 service worker. Orchestrates the whole flow.
//
//   • Right-click a YouTube thumbnail -> open the video in a hidden minimized window,
//     drive YouTube's "Ask -> summarize" UI in that tab, scrape the answer, close the
//     window, and show the result as an overlay in the tab you right-clicked from.
//   • Alt+Shift+S on a watch page -> drive the same flow in the current tab.

// Summary cache. Keyed by video (and, for "Ask", the question) so a video we've
// already summarized can be served instantly — as our embedded card on the watch
// page, or as the floating card for a repeat right-click/shortcut/Ask — without
// re-driving YouTube's "Ask" UI. Persisted (not in-memory) because the MV3 worker
// is frequently torn down. CACHE_MAX bounds how many we keep, so the cache stays
// well within the default local-storage quota.
const CACHE_KEY = "ytsum_summaries";
const CACHE_MAX = 200;

// videoId alone for summaries (the summarize prompt is fixed); videoId + normalized
// question for "Ask", so different questions never collide and an Ask answer is
// never served as a plain summary (or vice versa).
function cacheId(videoId, question) {
  const q = (question || "").trim().toLowerCase().replace(/\s+/g, " ");
  return q ? `ask ${videoId} ${q}` : `sum ${videoId}`;
}

async function cacheGet(videoId, question) {
  const r = await chrome.storage.local.get(CACHE_KEY);
  const m = r[CACHE_KEY] || {};
  return m[cacheId(videoId, question)] || null;
}

async function cachePut(videoId, question, out) {
  if (!videoId || !out) return;
  const r = await chrome.storage.local.get(CACHE_KEY);
  const m = r[CACHE_KEY] || {};
  m[cacheId(videoId, question)] = {
    text: out.text || "", html: out.html || "", title: out.title || "", ts: Date.now()
  };
  const ids = Object.keys(m); // hygiene cap: drop oldest by ts once over CACHE_MAX
  if (ids.length > CACHE_MAX) {
    ids.sort((a, b) => (m[a].ts || 0) - (m[b].ts || 0))
       .slice(0, ids.length - CACHE_MAX)
       .forEach((k) => delete m[k]);
  }
  await chrome.storage.local.set({ [CACHE_KEY]: m });
}

// Tabs that currently have a summary driver running in them. Used to ignore
// redundant auto-summarize triggers, and to keep the hidden-tab right-click
// flow from colliding with the auto-summarize that fires inside that same
// hidden tab (its content script loads a watch page too).
const drivingTabs = new Set();

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const linkPatterns = [
      "*://*.youtube.com/watch*",
      "*://*.youtube.com/shorts/*",
      "*://youtu.be/*"
    ];
    const pagePatterns = ["*://*.youtube.com/watch*", "*://*.youtube.com/shorts/*"];

    const SUMMARIZE = "Summarize this video";
    const ASK = "Ask a question";

    // Everything lives under one "Quick Summary" submenu. We register it as
    // TWO context-scoped parents (link vs. page/video) so each parent only shows
    // when its own children match — that avoids an empty submenu appearing on,
    // say, the YouTube home page. The two never show at once (a right-click is
    // either on a link or on the page/video, not both).

    // Parent A — right-clicking a thumbnail (a link to a video): act on the
    // linked video in a hidden background tab, so the user never leaves the page.
    chrome.contextMenus.create({
      id: "ytsum-parent-link", title: "Quick Summary",
      contexts: ["link"], targetUrlPatterns: linkPatterns
    });
    chrome.contextMenus.create({
      id: "ytsum-summarize-link", parentId: "ytsum-parent-link", title: SUMMARIZE,
      contexts: ["link"], targetUrlPatterns: linkPatterns
    });
    chrome.contextMenus.create({
      id: "ytsum-ask-link", parentId: "ytsum-parent-link", title: ASK,
      contexts: ["link"], targetUrlPatterns: linkPatterns
    });

    // Parent B — right-clicking the watch page itself: act on the current tab.
    chrome.contextMenus.create({
      id: "ytsum-parent-page", title: "Quick Summary",
      contexts: ["page", "video"], documentUrlPatterns: pagePatterns
    });
    chrome.contextMenus.create({
      id: "ytsum-summarize-page", parentId: "ytsum-parent-page", title: SUMMARIZE,
      contexts: ["page", "video"], documentUrlPatterns: pagePatterns
    });
    chrome.contextMenus.create({
      id: "ytsum-ask-page", parentId: "ytsum-parent-page", title: ASK,
      contexts: ["page", "video"], documentUrlPatterns: pagePatterns
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab && tab.id;
  switch (info.menuItemId) {
    case "ytsum-summarize-link": {
      const id = extractVideoId(info.linkUrl);
      if (id) runViaHiddenTab(id, tabId);
      break;
    }
    case "ytsum-ask-link": {
      const id = extractVideoId(info.linkUrl);
      // Ask the user for a question in the page they're on, then run the Ask
      // flow against the linked video in a hidden tab ("hidden" mode).
      if (id && tabId != null) promptQuestion(tabId, id, "hidden");
      break;
    }
    case "ytsum-summarize-page": {
      const id = extractVideoId(info.pageUrl || (tab && tab.url));
      if (id && tabId != null) runInTab(tabId, id); // already on the watch page
      break;
    }
    case "ytsum-ask-page": {
      const id = extractVideoId(info.pageUrl || (tab && tab.url));
      // Ask in-place, then run the Ask flow in this same watch tab ("inTab").
      if (id && tabId != null) promptQuestion(tabId, id, "inTab");
      break;
    }
  }
});

// ---------------------------------------------------------------------------
// Keyboard command
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "summarize-current") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const id = extractVideoId(tab.url);
  if (id) runInTab(tab.id, id);
});

// ---------------------------------------------------------------------------
// Messaging — content script + popup
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "autoSummarize") {
    // Sent by content.js when a watch page loads (auto-summarize on) for a video we
    // DON'T already have cached. We open YouTube's OWN "Ask → summarize" panel in
    // place (it renders a nicely formatted answer right on the page) and show none
    // of our own UI — but we also scrape that finished answer and cache it, so the
    // NEXT visit shows our embedded card instantly. Ignores tabs already being
    // driven (incl. the hidden orchestration tab), so it never collides with the
    // right-click flow.
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId != null) openNativeSummary(tabId, msg.videoId);
    return;
  }
  if (msg.type === "askQuestion") {
    // Sent by content.js after the user types a question into the in-page Ask
    // dialog. The dialog lives in the tab the user right-clicked from, so that
    // tab (sender) is where the answer card is shown. "hidden" mode came from a
    // thumbnail (drive the linked video in a background tab); "inTab" came from
    // the watch page itself (drive this same tab).
    const tabId = sender && sender.tab && sender.tab.id;
    const question = (msg.question || "").trim();
    if (tabId == null || !msg.videoId || !question) return;
    if (msg.mode === "hidden") runViaHiddenTab(msg.videoId, tabId, { question });
    else runInTab(tabId, msg.videoId, { question });
    return;
  }
  if (msg.type === "getCachedSummary") {
    // content.js asks on each watch-page load whether we already have this video's
    // summary, so it can render our embedded card instead of driving "Ask".
    cacheGet(msg.videoId, null).then((hit) => sendResponse(hit || null));
    return true; // async response
  }
  if (msg.type === "getSummaryCount") {
    // Popup shows how many summaries are cached (and disables Clear when none).
    chrome.storage.local.get(CACHE_KEY, (r) => sendResponse(Object.keys(r[CACHE_KEY] || {}).length));
    return true; // async response
  }
  if (msg.type === "clearSummaries") {
    // Popup's "Clear cached summaries": wipe the cache so every video is fetched
    // fresh again. Embedded cards already on screen stay until the next navigation.
    chrome.storage.local.set({ [CACHE_KEY]: {} }, () => sendResponse(true));
    return true; // async response
  }
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
// The video lives on a page the user is browsing (e.g. a thumbnail). Open it in
// a hidden, minimized, muted window, drive the Ask flow there, and show the
// result back in `sourceTabId`. `opts` is forwarded to the driver: `{ question }`
// asks that question; omitted means "summarize".
async function runViaHiddenTab(videoId, sourceTabId, opts) {
  opts = opts || {};
  if (!opts.refresh) {
    const hit = await cacheGet(videoId, opts.question);
    if (hit) { deliver(sourceTabId, videoId, { ok: true, text: hit.text, html: hit.html, title: hit.title }, opts); return; }
  }
  notify(sourceTabId, { type: "showLoading", videoId, question: opts.question });
  resolveName(videoId, sourceTabId); // fill the card's video name while it loads
  let win, tabId;
  try {
    win = await chrome.windows.create({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      focused: false,
      state: "minimized"
    });
    tabId = win.tabs && win.tabs[0] && win.tabs[0].id;
    if (!tabId) throw new Error("no-hidden-tab");
    // We drive this tab ourselves below, so mark it busy: if auto-summarize is on,
    // this hidden tab's own content script must NOT also kick off a driver.
    drivingTabs.add(tabId);

    // Mute ONLY this hidden tab so its autoplaying video is silent. This is scoped
    // to our specific tab id, so the user's other tabs/windows are never affected.
    try { await chrome.tabs.update(tabId, { muted: true }); } catch (_) {}

    await waitForComplete(tabId);
    await sleep(1500); // let YouTube's SPA hydrate the player + Ask UI

    const out = await runDriver(tabId, opts);
    deliver(sourceTabId, videoId, out, opts);
  } catch (e) {
    notify(sourceTabId, { type: "showError", videoId, question: opts.question, error: String(e && e.message || e) });
  } finally {
    if (tabId != null) drivingTabs.delete(tabId);
    if (win && win.id != null) chrome.windows.remove(win.id).catch(() => {});
  }
}

// Already on the watch page (context-menu "page" item, keyboard shortcut, or
// auto-summarize): drive the Ask flow in place and show the overlay in the same
// tab. `opts` is forwarded to the driver (`{ question }` to ask, else summarize).
// Re-entrant calls for a tab already being driven are ignored.
async function runInTab(tabId, videoId, opts) {
  opts = opts || {};
  if (!opts.refresh) {
    const hit = await cacheGet(videoId, opts.question);
    if (hit) { deliver(tabId, videoId, { ok: true, text: hit.text, html: hit.html, title: hit.title }, opts); return; }
  }
  if (drivingTabs.has(tabId)) return; // a request is already running in this tab
  drivingTabs.add(tabId);
  notify(tabId, { type: "showLoading", videoId, question: opts.question });
  resolveName(videoId, tabId); // fill the card's video name while it loads
  try {
    const out = await runDriver(tabId, opts);
    deliver(tabId, videoId, out, opts);
  } catch (e) {
    notify(tabId, { type: "showError", videoId, question: opts.question, error: String(e && e.message || e) });
  } finally {
    drivingTabs.delete(tabId);
  }
}

// Auto-summarize on a watch page the user is already viewing: drive the full Ask →
// summarize flow so YouTube renders its own answer panel in place (the visible auto
// UX is unchanged, and we show no card of our own), then SCRAPE that finished answer
// and cache it — so the next visit to this video serves our embedded card instantly.
// We only cache if the tab is still on the same video when the scrape ends (the user
// may have navigated away mid-stream). Silent on failure — if "Ask" isn't available,
// nothing happens (no error popup).
async function openNativeSummary(tabId, videoId) {
  if (drivingTabs.has(tabId)) return; // something is already driving this tab
  drivingTabs.add(tabId);
  try {
    const out = await runDriver(tabId, {});
    if (out && out.ok && videoId) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && extractVideoId(tab.url) === videoId) cachePut(videoId, null, out);
    }
  } catch (_) {
    // Intentionally silent in auto mode.
  } finally {
    drivingTabs.delete(tabId);
  }
}

// Ask the user for a question: show the in-page input dialog in `tabId`. The
// content script posts an "askQuestion" message back once the user submits, and
// `mode` ("hidden" | "inTab") tells us how to run it then.
function promptQuestion(tabId, videoId, mode) {
  notify(tabId, { type: "promptQuestion", videoId, mode });
}

function deliver(tabId, videoId, out, opts) {
  opts = opts || {};
  if (out && out.ok) {
    cachePut(videoId, opts.question, out); // remember it for instant re-serves
    notify(tabId, {
      type: "showSummary", videoId, text: out.text, html: out.html, question: opts.question,
      name: out.title || ""
    });
  } else {
    notify(tabId, {
      type: "showError", videoId, question: opts.question,
      error: (out && out.reason) || "unknown"
    });
  }
}

async function runDriver(tabId, opts) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: askDriver,
    args: [opts || {}]
  });
  return results && results[0] && results[0].result;
}

function notify(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// Resolve the video's human title and push it to the card as soon as we have it,
// so the loading popup can show the name before the summary arrives. Best-effort:
// the public oEmbed endpoint needs no auth, but returns nothing for private/age-
// restricted videos — in which case the name simply fills in once the summary
// (which carries the scraped title) lands.
async function resolveName(videoId, tabId) {
  const name = await fetchVideoTitle(videoId);
  if (name) notify(tabId, { type: "setName", videoId, name });
}

async function fetchVideoTitle(videoId) {
  try {
    const url = "https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=" + videoId);
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.title) || null;
  } catch (_) {
    return null;
  }
}

function extractVideoId(url) {
  if (!url) return null;
  try {
    const u = new URL(url, "https://www.youtube.com");
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null;
    const v = u.searchParams.get("v");
    return v || null;
  } catch (_) {
    const m = /[?&]v=([\w-]{11})/.exec(url) || /youtu\.be\/([\w-]{11})/.exec(url) || /shorts\/([\w-]{11})/.exec(url);
    return m ? m[1] : null;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitForComplete(tabId, timeout = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); clearTimeout(to); resolve(v); } };
    const listener = (id, changeInfo) => { if (id === tabId && changeInfo.status === "complete") finish(true); };
    const to = setTimeout(() => finish(false), timeout);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (t) => { if (t && t.status === "complete") finish(true); });
  });
}

// ===========================================================================
// askDriver — INJECTED INTO THE PAGE (isolated world) via chrome.scripting.
// Must be fully self-contained: no references to anything outside its body.
//
// It drives YouTube's real "Ask" UI: click "Ask", pick a summarize prompt (or type
// one), then wait for the answer text to appear and stabilize. Selectors are
// heuristic on purpose — the "Ask" UI is a gated experiment and its markup is
// unknown/obfuscated, so we match by visible text/aria.
// ===========================================================================
async function askDriver(opts) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const label = (el) => {
    if (!el) return "";
    return (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title")) || el.textContent || "").trim();
  };

  async function waitFor(fn, timeout, interval) {
    timeout = timeout || 12000; interval = interval || 300;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let v; try { v = fn(); } catch (_) { v = null; }
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  const clickables = () => Array.from(
    document.querySelectorAll('button, a, tp-yt-paper-button, yt-button-shape, [role="button"], yt-chip-cloud-chip-renderer, ytd-button-renderer')
  ).filter(visible);

  // Shared across the answer locator, the HTML builder and the text cleaner so they
  // agree on what is a clickable chip/suggestion vs. panel chrome.
  //   CLICK_SEL — suggestion prompts, follow-up question chips and links (dropped,
  //               except inline timestamps);
  //   CHROME_RE — the title, greeting, "AI can make mistakes" disclaimer and the
  //               "Ask ✦ Gemini" footer.
  const CLICK_SEL = 'a, button, [role="button"], [role="link"], [role="option"], tp-yt-paper-button, yt-button-shape, yt-chip-cloud-chip-renderer, ytd-button-renderer, tp-yt-paper-chip, ytd-toggle-button-renderer';
  const CHROME_RE = /(^ask about this video$|^ask a question|^ask anything|ask\b[\s\S]*\bgemini\b|curious about what you|not sure what to ask|choose something|recommend related content|^summarize (the|this) video$|ai can make mistakes|double-?check it|^learn more$)/i;

  // 1) Click "Ask"
  const ask = await waitFor(() => clickables().find((el) => {
    const t = label(el);
    return t.length > 0 && t.length < 24 && /(^|\s)ask(\s|$)/i.test(t);
  }), opts.askTimeout || 15000);
  if (!ask) return { ok: false, reason: "ask-not-found" };
  ask.click();
  await sleep(800);

  // 2) Decide what to ask.
  if (opts.question) {
    // Freeform question from the user: type it straight into the Ask box and
    // submit, ignoring any suggested prompt chips.
    if (!(await typePrompt(opts.question)))
      return { ok: false, reason: "no-input" };
  } else {
    // Summarize: prefer a suggested prompt chip containing "summar"...
    const chip = await waitFor(() => clickables().find((el) => {
      const t = label(el);
      return t.length > 0 && t.length < 80 && /summar/i.test(t);
    }), opts.chipTimeout || 6000);
    if (chip) {
      chip.click();
    } else if (!(await typePrompt(opts.prompt || "Summarize this video in a few concise bullet points."))) {
      // ...otherwise type a summarize prompt ourselves.
      return { ok: false, reason: "no-summarize-and-no-input" };
    }
  }

  // Auto-summarize only needed to OPEN YouTube's own answer panel; it renders the
  // formatted answer in place, so we don't scrape or return anything to show.
  if (opts.triggerOnly) return { ok: true, triggered: true };

  // 3) Wait for YouTube's answer to finish streaming, then capture it WITH
  //    formatting (headings, bullets, bold, timestamps). The panel's layout shifts
  //    once a conversation starts (the "Ask about this video" header is replaced by
  //    the chat log), so we no longer trust a title/input common-ancestor to bound
  //    the answer — that lands on the input + chips and DROPS the answer. Instead we
  //    locate the answer by its CONTENT (the densest prose sharing a panel with the
  //    Ask input) via findAnswerRoot, falling back to findAskPanel only if that's
  //    empty. buildAnswerHtml then keeps everything in that region that ISN'T chrome
  //    (so the summary can never be dropped) while removing the suggested-prompt
  //    chips, follow-up question chips, greeting, disclaimer, title and input box.
  const located = await waitFor(() => findAnswerRoot(), opts.panelTimeout || 12000);
  const panel = located || findAskPanel();
  const root = (await waitForStableAnswer(panel, opts.answerTimeout || 45000, opts.question)) || panel;
  const html = buildAnswerHtml(root, opts.question);
  const text = html ? htmlToText(html) : clean((root && root.innerText) || "", opts.question);
  if (!html && !text) return { ok: false, reason: "no-answer" };
  // Don't surface a capture that is nothing but YouTube's suggested questions as if
  // it were the summary — report it missing so the user retries (or sees the error).
  if (isOnlySuggestions(text)) return { ok: false, reason: "no-answer" };
  return { ok: true, text, html, title: (document.title || "").replace(/\s*-\s*YouTube\s*$/, "") };

  // --- helpers -----------------------------------------------------------
  // Type `text` into the Ask input box and submit it. Returns false if no usable
  // input is present. Used for freeform questions and as the summarize fallback
  // when YouTube offers no suggested prompt chip.
  async function typePrompt(text) {
    // Target the Ask conversation box specifically. We must NOT fall back to the
    // page's Search box: it's the first text input in the DOM, so a naive
    // querySelector grabs it, and the Enter we dispatch below would submit a
    // search — navigating the tab to youtube.com/results with our prompt as the
    // query. askInput() prefers an "ask"-labelled box; the extra guard makes sure
    // we never type into anything that looks like search, even as a last resort.
    const isSearchBox = (el) => {
      const s = (((el.getAttribute && el.getAttribute("placeholder")) || "") + " " +
                 ((el.getAttribute && el.getAttribute("aria-label")) || "") + " " +
                 (el.id || "") + " " + (el.name || "")).toLowerCase();
      return /search/.test(s);
    };
    const input = await waitFor(() => {
      const el = askInput();
      return el && visible(el) && !isSearchBox(el) ? el : null;
    }, 6000);
    if (!input) return false;
    input.focus();
    if ("value" in input) {
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value");
      setter && setter.set ? setter.set.call(input, text) : (input.value = text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      input.textContent = text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    await sleep(300);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    const send = clickables().find((el) => /send|submit/i.test(label(el)));
    if (send) send.click();
    return true;
  }

  function directText(el) {
    let s = "";
    const kids = (el && el.childNodes) || [];
    for (let i = 0; i < kids.length; i++) if (kids[i].nodeType === 3) s += kids[i].nodeValue;
    return s.trim();
  }

  function findByText(lower) {
    const els = document.querySelectorAll('h1,h2,h3,h4,span,div,yt-formatted-string,[role="heading"]');
    for (let i = 0; i < els.length; i++) {
      if (visible(els[i]) && directText(els[i]).toLowerCase() === lower) return els[i];
    }
    return null;
  }

  function climb(el, n) {
    let p = el;
    for (let i = 0; i < n && p && p.parentElement; i++) p = p.parentElement;
    return p;
  }

  function commonAncestor(a, b) {
    const seen = new Set();
    let x = a;
    while (x) { seen.add(x); x = x.parentElement; }
    let y = b;
    while (y) { if (seen.has(y)) return y; y = y.parentElement; }
    return document.body;
  }

  // Find the panel by anchoring on its title ("Ask about this video") and/or its
  // input box ("Ask a question..."); their common ancestor is the whole panel.
  // Kept as the fallback locator for findAnswerRoot.
  function findAskPanel() {
    const input = askInput();
    const title = findByText("ask about this video");
    if (title && input) return commonAncestor(title, input);
    if (title) return climb(title, 6);
    if (input) return climb(input, 8);
    return null;
  }

  // The Ask conversation's text box. Prefer one whose placeholder/label names
  // "ask"; never the page's Search box (so we don't anchor the panel on chrome).
  function askInput() {
    const cands = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')).filter(visible);
    const attr = (el) => ((el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "")).toLowerCase();
    return cands.find((el) => /ask/.test(attr(el))) ||
           cands.find((el) => !/search/.test(attr(el))) ||
           cands[0] || null;
  }

  // Rough "how much real answer prose lives in here" score: the summed length of
  // visible, sentence-like leaf blocks that AREN'T inside a clickable chip/link and
  // AREN'T panel chrome. Chips, suggestions, follow-up questions and the greeting all
  // score ~0; the streamed answer scores high. Lets us locate the answer by content,
  // independent of the panel's (shifting) header/title markup.
  function answerScore(root) {
    if (!root) return 0;
    let len = 0;
    const blocks = root.querySelectorAll('p, li, yt-formatted-string, [class*="markdown" i]');
    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      if (!visible(el)) continue;
      if (el.querySelector('p, li, yt-formatted-string')) continue; // leaf blocks only (no double count)
      if (el.closest(CLICK_SEL)) continue;                          // skip chips/suggestions/links
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length < 25 || !/[.!?:]/.test(t) || CHROME_RE.test(t)) continue;
      if (isSuggestionLine(t)) continue; // suggested-question chips aren't answer prose
      len += t.length;
    }
    return len;
  }

  // A short, single interrogative line — the shape of YouTube's suggested prompt /
  // follow-up question chips ("Why is wet concrete dangerous?"). Used to keep them
  // out of the answer score, and to detect a capture that is nothing BUT
  // suggestions. The trailing-punctuation check (no '.', '!' or ':' before the
  // final '?') keeps a real multi-sentence paragraph that happens to end in a
  // question from being misclassified as a chip.
  function isSuggestionLine(t) {
    const s = (t || "").replace(/\s+/g, " ").trim();
    return s.length > 0 && s.length <= 120 && /\?$/.test(s) &&
           s.split(" ").length <= 16 && !/[.!:]/.test(s.slice(0, -1));
  }

  // True when the captured "answer" is really just a list of suggested questions
  // (the answer never streamed, or the locator missed it). At least two question
  // lines and nothing else — a genuine summary always carries declarative prose.
  function isOnlySuggestions(text) {
    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return false;
    return lines.every(isSuggestionLine);
  }

  // Locate the element that actually holds the streamed answer. Anchor on the Ask
  // input (stable across the conversation) and climb to the TIGHTEST ancestor that
  // contains the answer prose, stopping before we'd climb out into the page's own
  // description/comments. Returns null until enough answer text exists, so the caller
  // falls back to findAskPanel and keeps polling.
  function findAnswerRoot() {
    const input = askInput();
    if (!input) return bestAskContainer();
    let node = input.parentElement, best = null, bestScore = 0;
    for (let i = 0; i < 12 && node && node !== document.body && node !== document.documentElement; i++) {
      if (node.querySelector('#comments, ytd-comments, #movie_player, #primary #below')) break; // left the panel
      const score = answerScore(node);
      if (score > bestScore) { bestScore = score; best = node; }
      if (score >= 120) { best = node; break; } // tight container already holds the answer
      node = node.parentElement;
    }
    return bestScore >= 40 ? best : null;
  }

  // Fallback locator when no input is found: the highest-scoring container that
  // looks like the Ask / Gemini conversation panel.
  function bestAskContainer() {
    const cands = Array.from(document.querySelectorAll(
      'ytd-engagement-panel-section-list-renderer, [target-id*="ask" i], [class*="conversation" i], [class*="gemini" i], [aria-label*="ask" i]'
    )).filter(visible);
    let best = null, bestScore = 0;
    for (let i = 0; i < cands.length; i++) { const s = answerScore(cands[i]); if (s > bestScore) { bestScore = s; best = cands[i]; } }
    return bestScore >= 40 ? best : null;
  }

  // Plain-text view of the answer derived from the already-cleaned HTML, so the text
  // fallback / Copy text inherit the same chip & chrome removal as the rich HTML.
  function htmlToText(html) {
    return String(html || "")
      .replace(/<\/(p|li|h[1-6]|div|ul|ol|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      .split("\n").map((l) => l.trim()).filter(Boolean).join("\n")
      .trim();
  }

  // Build a formatted, junk-free HTML view of the answer by walking the LIVE
  // panel. The guiding principle: KEEP everything that isn't chrome (so the
  // summary itself can never be dropped) and remove only the parts that clearly
  // aren't the answer:
  //   • clickable suggestions — the prompt chips and follow-up question links
  //     (kept ONLY when they're an inline timestamp like "0:56");
  //   • short chrome text — the title, greeting, the "AI can make mistakes…"
  //     disclaimer, the "Ask ✦ Gemini" footer, and static suggestion labels;
  //   • icons and the input box.
  // Headings, bullets, bold and timestamps are preserved. Only a small fixed set
  // of tags is emitted and every text node is escaped, so the result is safe.
  function buildAnswerHtml(root, question) {
    if (!root) return "";
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const TS = /^\(?\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*\)?$/; // 0:56, 12:34, (1:02:03)
    const SKIP = 'svg, img, style, script, noscript, textarea, input, [contenteditable="true"], yt-icon, iron-icon';
    const Q = (question || "").replace(/\s+/g, " ").trim().toLowerCase(); // the echoed user question
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const isTs = (t) => t.length <= 12 && TS.test(t);
    const tsSpan = (el) => '<span class="ytsum-ts">' + esc(norm(el.innerText)) + "</span>";

    function walk(node) {
      let out = "";
      const kids = node.childNodes || [];
      for (let i = 0; i < kids.length; i++) {
        const n = kids[i];
        if (n.nodeType === 3) { out += esc(n.nodeValue); continue; }
        if (n.nodeType !== 1) continue;
        const el = n;
        if (!visible(el) || el.matches(SKIP)) continue;
        const t = norm(el.innerText);

        // Clickable suggestions/links: drop them — unless the whole thing is just an
        // inline timestamp (kept), or it's a LONG / list-bearing clickable, which is
        // more likely a wrapper around the answer than a chip, so we walk into it
        // rather than dropping the answer.
        if (el.matches(CLICK_SEL)) {
          if (isTs(t)) { out += tsSpan(el); continue; }
          if (t.length <= 220 && !el.querySelector("li, p")) continue;
        }
        // Short chrome lines (title / greeting / disclaimer / footer / labels) and
        // the echoed user question.
        if (t && t.length < 200 && CHROME_RE.test(t) && !el.querySelector("li")) continue;
        if (Q && t.length < 200 && norm(t).toLowerCase() === Q && !el.querySelector("li")) continue;

        const tag = el.tagName;
        if (tag === "BR") { out += "<br>"; continue; }
        if (tag === "UL" || tag === "OL") {
          const inner = listHtml(el);
          if (inner) out += "<" + tag.toLowerCase() + ">" + inner + "</" + tag.toLowerCase() + ">";
          continue;
        }
        if (tag === "LI") { const inner = walk(el); if (inner.trim()) out += "<li>" + inner + "</li>"; continue; }
        if (isTs(t)) { out += tsSpan(el); continue; } // standalone timestamp token

        const inner = walk(el);
        if (!inner.trim()) continue;
        if (/^H[1-6]$/.test(tag)) { out += "<h3>" + inner + "</h3>"; continue; }
        if (tag === "P") { out += "<p>" + inner + "</p>"; continue; }
        if (tag === "STRONG" || tag === "B") { out += "<strong>" + inner + "</strong>"; continue; }
        if (tag === "EM" || tag === "I") { out += "<em>" + inner + "</em>"; continue; }

        // No semantic tag: infer heading/bold/italic from the computed style so we
        // still capture YouTube's formatting when it styles via CSS classes.
        const cs = getComputedStyle(el);
        const block = /block|flex|grid|list-item|table|box/.test(cs.display);
        const bold = cs.fontWeight === "bold" || (parseInt(cs.fontWeight, 10) || 0) >= 600;
        if (block && bold && t && t.length <= 90) { out += "<h3>" + inner + "</h3>"; continue; }
        if (bold) { out += "<strong>" + inner + "</strong>"; continue; }
        if (cs.fontStyle === "italic") { out += "<em>" + inner + "</em>"; continue; }
        out += block ? ("<div>" + inner + "</div>") : inner;
      }
      return out;
    }

    function listHtml(ul) {
      let out = "";
      const kids = ul.children || [];
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (!visible(c) || c.matches(SKIP)) continue;
        if (c.tagName === "LI") { const inner = walk(c); if (inner.trim()) out += "<li>" + inner + "</li>"; }
        else if (c.tagName === "UL" || c.tagName === "OL") out += "<" + c.tagName.toLowerCase() + ">" + listHtml(c) + "</" + c.tagName.toLowerCase() + ">";
      }
      return out;
    }

    return walk(root)
      .replace(/(<div>\s*<\/div>)+/g, "")     // drop empty wrappers
      .replace(/(<br>\s*){2,}/g, "<br>")       // collapse blank runs
      .trim();
  }

  // Drop the panel chrome (title, input placeholder, the "Ask ✦ Gemini" footer,
  // the greeting/suggested-prompt lines, stray icon glyphs) and keep only the
  // answer body. Used for the plain-text fallback and the Copy button.
  function clean(t, question) {
    const Q = (question || "").replace(/\s+/g, " ").trim().toLowerCase();
    return (t || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => {
        if (!l) return false;
        if (/^[×✕✦◆•‣*\s]+$/.test(l)) return false; // icon/glyph-only lines
        if (Q && l.toLowerCase() === Q) return false; // the echoed question
        if (CHROME_RE.test(l)) return false;          // title/greeting/disclaimer/footer
        return true;
      })
      .join("\n")
      .trim();
  }

  // Last resort if the panel can't be located: take the common ancestor of all
  // answer-looking text blocks.
  function fallbackRead() {
    const leaves = Array.from(document.querySelectorAll('yt-formatted-string, [class*="markdown"], [class*="message"], [class*="answer"], [class*="response"], li, p'))
      .filter(visible)
      .filter((el) => { const t = (el.innerText || "").trim(); return t.length > 40 && /[.!?:]/.test(t); });
    if (!leaves.length) return "";
    let anc = leaves[0];
    for (let i = 1; i < leaves.length; i++) anc = commonAncestor(anc, leaves[i]);
    return clean(anc.innerText || "");
  }

  // Poll until the (streaming) answer stops growing, then return the ELEMENT that
  // holds it. The answer region is re-located on every tick (it can appear or move
  // as the conversation streams in), so extraction reads exactly what we waited on.
  async function waitForStableAnswer(initial, timeout, question) {
    const start = Date.now();
    let root = initial, best = "", last = "", stable = 0;
    while (Date.now() - start < timeout) {
      const r = findAnswerRoot() || initial;
      if (r) root = r;
      const t = root ? clean(root.innerText || "", question) : fallbackRead();
      if (t.length >= best.length) best = t;
      if (t && t === last) { if (++stable >= 5) break; }
      else { stable = 0; last = t; }
      await sleep(500);
    }
    return root;
  }

}
