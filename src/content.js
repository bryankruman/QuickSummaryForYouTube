// content.js — runs in the ISOLATED content-script world on youtube.com pages.
//
// Renders the floating summary card, the embedded watch-page summary card, and the
// "Ask a question" dialog; listens for show/loading/error messages from the service
// worker; and drives the optional auto-summarize-on-navigation behavior.

(function () {
  // The UI only belongs in the top-level frame. The manifest already scopes the
  // content script there; this guard is just belt-and-suspenders.
  if (window.top !== window) return;

  // --- Overlay UI --------------------------------------------------------
  let host = null;
  let currentVideoId = null; // video the visible card is for; guards async setName

  // Persisted popup geometry ({left, top, width, height}). The user can drag the
  // titlebar to move the card and the corners to resize it; we save the result so
  // it reopens where they left it. The extension popup's "Reset" button clears
  // this key, which we observe via storage.onChanged below.
  const POPUP_KEY = "ytsum_popup";
  const MIN_W = 280, MIN_H = 160;
  let popupGeom = null;

  function ensureCard() {
    if (host && document.documentElement.contains(host)) return host;
    host = document.createElement("div");
    host.id = "ytsum-root";
    // The copy control is an inline SVG icon (no external assets); the close "×"
    // is enlarged via CSS. Resize handles sit at each corner.
    host.innerHTML = `
      <div class="ytsum-card" role="dialog" aria-label="Video summary">
        <div class="ytsum-head">
          <span class="ytsum-title">Video Summary</span>
          <div class="ytsum-actions">
            <button class="ytsum-copy" title="Copy summary" aria-label="Copy summary">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
            <button class="ytsum-close" title="Close" aria-label="Close">×</button>
          </div>
        </div>
        <div class="ytsum-content">
          <div class="ytsum-name"></div>
          <a class="ytsum-link" target="_blank" rel="noopener noreferrer"></a>
          <div class="ytsum-sub"></div>
          <div class="ytsum-body"></div>
        </div>
        <div class="ytsum-resize ytsum-resize-nw" data-corner="nw"></div>
        <div class="ytsum-resize ytsum-resize-ne" data-corner="ne"></div>
        <div class="ytsum-resize ytsum-resize-sw" data-corner="sw"></div>
        <div class="ytsum-resize ytsum-resize-se" data-corner="se"></div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);
    const card = host.querySelector(".ytsum-card");
    host.querySelector(".ytsum-close").addEventListener("click", hide);
    host.querySelector(".ytsum-copy").addEventListener("click", () => {
      const text = host.querySelector(".ytsum-body").innerText || "";
      navigator.clipboard.writeText(text).catch(() => {});
    });
    // Delegated so it covers every timestamp link rebuilt into the body later.
    host.querySelector(".ytsum-body").addEventListener("click", onTimestampClick);
    makeDraggable(host, host.querySelector(".ytsum-head"));
    host.querySelectorAll(".ytsum-resize").forEach((h) =>
      makeResizable(host, card, h, h.getAttribute("data-corner")));
    applyGeom(); // restore saved position/size if we have one
    return host;
  }

  // Closing fully removes the card so nothing stale can keep it hidden later.
  function hide() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
  }

  // Called at the start of every summary request so the card always comes back,
  // even if it was previously closed. Clears any lingering/detached instances.
  function resetCard() {
    document.querySelectorAll("#ytsum-root").forEach((n) => n.remove());
    host = null;
  }

  // --- Move / resize / persistence ---------------------------------------
  // YouTube's stylesheet can't bleed in (everything is `!important`), so to win
  // the cascade our own inline overrides must ALSO be `!important` — set/cleared
  // via setProperty so dragging beats `right: 20px !important` in overlay.css.
  function setImp(el, prop, val) { el.style.setProperty(prop, val, "important"); }
  function clearImp(el) {
    for (let i = 1; i < arguments.length; i++) el.style.removeProperty(arguments[i]);
  }

  // Keep a saved geometry usable even if the viewport shrank since: never let the
  // card escape the screen or collapse below its minimum size.
  function clampGeom(g) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const out = Object.assign({}, g);
    if (typeof out.width === "number") out.width = Math.max(MIN_W, Math.min(out.width, vw));
    if (typeof out.height === "number") out.height = Math.max(MIN_H, Math.min(out.height, vh));
    if (typeof out.left === "number") {
      const w = typeof out.width === "number" ? out.width : 360;
      out.left = Math.max(0, Math.min(out.left, Math.max(0, vw - w)));
    }
    if (typeof out.top === "number") out.top = Math.max(0, Math.min(out.top, Math.max(0, vh - 44)));
    return out;
  }

  function applyGeom() {
    if (!host || !popupGeom) return;
    const card = host.querySelector(".ytsum-card");
    if (!card) return;
    const g = clampGeom(popupGeom);
    if (typeof g.left === "number") {
      setImp(host, "left", g.left + "px");
      setImp(host, "top", g.top + "px");
      setImp(host, "right", "auto");
    }
    if (typeof g.width === "number") setImp(card, "width", g.width + "px");
    if (typeof g.height === "number") { setImp(card, "height", g.height + "px"); setImp(card, "max-height", "none"); }
  }

  // Drop every inline override so the card falls back to its overlay.css defaults
  // (top-right, 360px, max-height 70vh). Used when the user resets from the popup.
  function resetGeom() {
    if (!host) return;
    const card = host.querySelector(".ytsum-card");
    clearImp(host, "left", "top", "right");
    if (card) clearImp(card, "width", "height", "max-height");
  }

  function saveGeom(partial) {
    popupGeom = Object.assign({}, popupGeom, partial);
    try { chrome.storage.local.set({ [POPUP_KEY]: popupGeom }); } catch (_) {}
  }

  // Drag the titlebar to move the whole popup. Mousedowns on the action buttons or
  // the corner handles are left alone so clicking/resizing still works.
  function makeDraggable(root, handle) {
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest(".ytsum-actions, .ytsum-resize")) return;
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const baseL = rect.left, baseT = rect.top, w = rect.width, h = rect.height;
      const vw = window.innerWidth, vh = window.innerHeight;
      setImp(root, "left", baseL + "px"); setImp(root, "top", baseT + "px"); setImp(root, "right", "auto");
      const onMove = (ev) => {
        const l = Math.max(0, Math.min(baseL + (ev.clientX - startX), Math.max(0, vw - w)));
        const t = Math.max(0, Math.min(baseT + (ev.clientY - startY), Math.max(0, vh - h)));
        setImp(root, "left", l + "px"); setImp(root, "top", t + "px");
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        const r = root.getBoundingClientRect();
        saveGeom({ left: Math.round(r.left), top: Math.round(r.top) });
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });
  }

  // Drag a corner handle to resize. The opposite edge stays pinned, so west/north
  // corners move the card's origin as the size changes.
  function makeResizable(root, card, handle, corner) {
    const west = corner === "nw" || corner === "sw";
    const north = corner === "nw" || corner === "ne";
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = root.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const baseL = rect.left, baseT = rect.top, baseW = rect.width, baseH = rect.height;
      const vw = window.innerWidth, vh = window.innerHeight;
      setImp(root, "left", baseL + "px"); setImp(root, "top", baseT + "px"); setImp(root, "right", "auto");
      setImp(card, "width", baseW + "px"); setImp(card, "height", baseH + "px"); setImp(card, "max-height", "none");
      const onMove = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        let w = west ? baseW - dx : baseW + dx;
        let h = north ? baseH - dy : baseH + dy;
        let l = west ? baseL + dx : baseL;
        let t = north ? baseT + dy : baseT;
        if (w < MIN_W) { if (west) l -= (MIN_W - w); w = MIN_W; }
        if (h < MIN_H) { if (north) t -= (MIN_H - h); h = MIN_H; }
        if (l < 0) { if (west) w += l; l = 0; }
        if (t < 0) { if (north) h += t; t = 0; }
        if (!west && l + w > vw) w = vw - l;
        if (!north && t + h > vh) h = vh - t;
        setImp(root, "left", l + "px"); setImp(root, "top", t + "px");
        setImp(card, "width", w + "px"); setImp(card, "height", h + "px");
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        const r = root.getBoundingClientRect();
        saveGeom({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });
  }

  // Load saved geometry, and react live to the popup's "Reset" (key removed).
  chrome.storage.local.get(POPUP_KEY, (r) => { popupGeom = r[POPUP_KEY] || null; applyGeom(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(POPUP_KEY in changes)) return;
    popupGeom = changes[POPUP_KEY].newValue || null;
    if (popupGeom) applyGeom(); else resetGeom();
  });

  function render({ state, title, name, sub, videoId, text, html, reasons }) {
    const card = ensureCard();
    card.style.display = "block";
    currentVideoId = videoId || null;
    card.querySelector(".ytsum-title").textContent = title || "Video Summary";

    // Video name, shown just under the titlebar (above the link). `undefined`
    // leaves any existing name in place (so an error after loading keeps it); an
    // empty string clears it.
    if (name !== undefined) setNameText(name);

    // Link to the video, just under the titlebar (replaces the old "video <id>"
    // line). encodeURIComponent keeps the href safe even though ids are [\w-]{11}.
    const link = card.querySelector(".ytsum-link");
    if (videoId) {
      const url = "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId);
      link.href = url;
      link.textContent = url;
      link.style.display = "block";
    } else {
      link.removeAttribute("href");
      link.textContent = "";
      link.style.display = "none";
    }

    // Secondary line, now used only for the question in "Ask" mode.
    const subEl = card.querySelector(".ytsum-sub");
    subEl.textContent = sub || "";
    subEl.style.display = sub ? "block" : "none";

    const body = card.querySelector(".ytsum-body");
    body.classList.toggle("ytsum-loading", state === "loading");
    body.classList.remove("ytsum-rich");
    body.textContent = "";

    if (state === "loading") {
      body.textContent = text || "Retrieving summary…";
    } else if (state === "error") {
      // A friendly headline plus a bulleted list of why this might have happened,
      // built with DOM nodes (not innerHTML) so it stays injection-safe.
      const msg = document.createElement("div");
      msg.className = "ytsum-err-msg";
      msg.textContent = text || "We couldn't retrieve the AI summary.";
      body.appendChild(msg);

      if (reasons && reasons.length) {
        const intro = document.createElement("div");
        intro.className = "ytsum-err-intro";
        intro.textContent = "Possible reasons:";
        body.appendChild(intro);

        const ul = document.createElement("ul");
        ul.className = "ytsum-reasons";
        reasons.forEach((r) => {
          const li = document.createElement("li");
          li.textContent = r;
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
    } else {
      // state === "ok": render YouTube's formatted answer when we have it, else
      // fall back to plain text.
      const rich = !!(html && renderRich(body, html, videoId));
      body.classList.toggle("ytsum-rich", rich);
      if (!rich) body.textContent = text || "";
    }
  }

  // Write the video name into the card, cleaning YouTube's "(3) " unread badge and
  // " - YouTube" suffix. Empty -> the line is hidden. Used by render and by the
  // async setName message (the name often isn't known when loading starts).
  function setNameText(name) {
    if (!host) return;
    const el = host.querySelector(".ytsum-name");
    if (!el) return;
    const t = cleanTitle(name);
    el.textContent = t;
    el.style.display = t ? "block" : "none";
  }

  function cleanTitle(t) {
    return String(t || "")
      .replace(/^\(\d+\)\s*/, "")
      .replace(/\s*-\s*YouTube\s*$/, "")
      .trim();
  }

  // The video's name as known locally: only when THIS tab is the watch page for
  // exactly `videoId` (the in-tab summarize/shortcut flow). For the thumbnail flow
  // the card lives on another page, so this returns "" and the name arrives later
  // via the worker's setName message.
  function localVideoName(videoId) {
    return onWatchPageFor(videoId) ? cleanTitle(document.title) : "";
  }

  // --- Safe rendering of YouTube's formatted answer ----------------------
  // The worker captures the answer's raw HTML (so we keep headings, bullets,
  // bold and timestamps). We never trust it: we re-parse it detached and rebuild
  // it from a strict tag allowlist, creating fresh elements with NO attributes
  // copied from the source — so no scripts, event handlers, styles, or remote
  // resources can come through. The one exception is timestamp links, whose href
  // we build ourselves from a fixed https scheme + the known video id + integer
  // seconds (never read off the source node), so it stays just as safe.
  const KEEP_TAGS = new Set([
    "STRONG", "B", "EM", "I", "U", "UL", "OL", "LI", "P", "BR",
    "H1", "H2", "H3", "H4", "H5", "H6", "CODE", "PRE", "BLOCKQUOTE", "SPAN", "DIV"
  ]);
  const DROP_TAGS = new Set(["SCRIPT", "STYLE", "SVG", "IMG", "BUTTON", "TEXTAREA", "INPUT", "IFRAME"]);
  const TS_RE = /^\(?\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*\)?$/; // 0:56, 12:34, (1:02:03)

  // Parse a timestamp token into whole seconds: "0:56"->56, "12:34"->754,
  // "1:02:03"->3723. Returns null if it isn't one, so the caller can fall back
  // to a plain, non-clickable label.
  function tsToSeconds(raw) {
    const m = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/.exec(String(raw || ""));
    if (!m) return null;
    const sec = parseInt(m[3], 10);
    if (sec >= 60) return null;
    return (m[1] ? parseInt(m[1], 10) : 0) * 3600 + parseInt(m[2], 10) * 60 + sec;
  }

  function rebuildNodes(src, videoId) {
    const frag = document.createDocumentFragment();
    src.childNodes.forEach((n) => {
      if (n.nodeType === 3) { frag.appendChild(document.createTextNode(n.nodeValue)); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      const t = (n.textContent || "").trim();
      // Timestamps (usually <a>, or a span the worker tagged). Checked before the
      // drop list so a timestamp rendered as a <button> still survives. When we
      // know the video and can read the time off the text, emit a real link that
      // jumps to that moment; otherwise keep the old non-clickable blue span.
      if (tag === "A" || (t.length <= 12 && TS_RE.test(t))) {
        const secs = tsToSeconds(t);
        let node;
        if (videoId && secs != null) {
          node = document.createElement("a");
          node.href = "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId) + "&t=" + secs + "s";
          node.dataset.seconds = String(secs);
          node.dataset.videoId = videoId;
        } else {
          node = document.createElement("span");
        }
        node.className = "ytsum-ts";
        node.appendChild(rebuildNodes(n, videoId));
        frag.appendChild(node);
        return;
      }
      if (DROP_TAGS.has(tag)) return;            // drop element and its subtree
      if (!KEEP_TAGS.has(tag)) { frag.appendChild(rebuildNodes(n, videoId)); return; } // unwrap
      const el = document.createElement(tag.toLowerCase());
      el.appendChild(rebuildNodes(n, videoId));
      frag.appendChild(el);
    });
    return frag;
  }

  // Render `html` into `body`, linking timestamps to `videoId`. Returns false (so
  // the caller can fall back to plain text) if parsing fails or there's no
  // meaningful content.
  function renderRich(body, html, videoId) {
    let doc;
    try { doc = new DOMParser().parseFromString(html, "text/html"); } catch (_) { return false; }
    const frag = rebuildNodes(doc.body, videoId);
    if (!(frag.textContent || "").trim()) return false;
    body.appendChild(frag);
    return true;
  }

  // Clicking a timestamp link: if we're already on that video's watch page, seek
  // the live player in place (instant, no reload) and start playing; otherwise we
  // do nothing here and let the <a>'s href load the video at that time. Modifier
  // and non-left clicks are left to the browser so "open in new tab" still works.
  function onTimestampClick(e) {
    const a = e.target.closest && e.target.closest("a.ytsum-ts");
    if (!a) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const secs = Number(a.dataset.seconds);
    if (!Number.isFinite(secs) || !onWatchPageFor(a.dataset.videoId)) return; // let href navigate
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (!video) return; // no player to seek; let href navigate (reloads at &t=)
    e.preventDefault();
    try { video.currentTime = secs; } catch (_) {}
    const p = video.play && video.play();
    if (p && p.catch) p.catch(() => {});
  }

  // True when this tab is the regular /watch page for exactly `id`. Comparing the
  // link's target id to the page's ?v= (not just "are we on a watch page") means a
  // summary card for a different video than the one playing still navigates away
  // instead of seeking the wrong player.
  function onWatchPageFor(id) {
    if (!id) return false;
    try {
      const u = new URL(location.href);
      return u.pathname === "/watch" && u.searchParams.get("v") === id;
    } catch (_) { return false; }
  }

  // --- "Ask a question" input dialog -------------------------------------
  // Shown when the user picks "Ask a question" from the right-click menu. The
  // typed question is sent to the worker, which types it into YouTube's Ask box
  // and streams the answer back into the normal result card.
  let askHost = null;

  function hideAsk() {
    if (askHost && askHost.parentNode) askHost.parentNode.removeChild(askHost);
    askHost = null;
  }

  function showAskDialog(videoId, mode) {
    document.querySelectorAll("#ytsum-ask-root").forEach((n) => n.remove());
    askHost = document.createElement("div");
    askHost.id = "ytsum-ask-root";
    // Static markup only — the video id and the user's question are set via
    // textContent/value below, never interpolated into HTML.
    askHost.innerHTML = `
      <div class="ytsum-card" role="dialog" aria-label="Ask about this video">
        <div class="ytsum-head">
          <span class="ytsum-title">Ask about this video</span>
          <div class="ytsum-actions">
            <button class="ytsum-close" title="Close" aria-label="Close">×</button>
          </div>
        </div>
        <div class="ytsum-sub"></div>
        <textarea class="ytsum-ask-input" rows="3" placeholder="Ask anything about this video…"></textarea>
        <div class="ytsum-ask-actions">
          <button class="ytsum-ask-cancel">Cancel</button>
          <button class="ytsum-ask-submit">Ask</button>
        </div>
      </div>`;
    (document.body || document.documentElement).appendChild(askHost);
    askHost.querySelector(".ytsum-sub").textContent = videoId ? "video " + videoId : "";
    const input = askHost.querySelector(".ytsum-ask-input");

    const submit = () => {
      const q = (input.value || "").trim();
      if (!q) { input.focus(); return; }
      hideAsk();
      chrome.runtime.sendMessage({ type: "askQuestion", videoId, mode, question: q });
      // Instant feedback while the worker spins up; it sends its own showLoading
      // shortly after, with the same content.
      resetCard();
      render({ state: "loading", title: "Answer", name: localVideoName(videoId), sub: q, videoId, text: "Retrieving answer…" });
    };

    askHost.querySelector(".ytsum-ask-submit").addEventListener("click", submit);
    askHost.querySelector(".ytsum-ask-cancel").addEventListener("click", hideAsk);
    askHost.querySelector(".ytsum-close").addEventListener("click", hideAsk);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); hideAsk(); }
    });
    setTimeout(() => { try { input.focus(); } catch (_) {} }, 0);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "promptQuestion") {
      showAskDialog(msg.videoId, msg.mode);
    } else if (msg.type === "showLoading") {
      resetCard(); // guarantee a fresh, visible card for every new request
      const name = localVideoName(msg.videoId);
      render(msg.question
        ? { state: "loading", title: "Answer", name, sub: msg.question, videoId: msg.videoId, text: "Retrieving answer…" }
        : { state: "loading", title: "Video Summary", name, videoId: msg.videoId, text: "Retrieving summary…" });
    } else if (msg.type === "setName") {
      // The worker resolved the video's title (e.g. via oEmbed for the thumbnail
      // flow); fill it in if this card is still showing that video.
      if (msg.videoId === currentVideoId && msg.name) setNameText(msg.name);
    } else if (msg.type === "showSummary") {
      render(msg.question
        ? { state: "ok", title: "Answer", name: msg.name || "", sub: msg.question, videoId: msg.videoId, text: msg.text, html: msg.html }
        : { state: "ok", title: "Video Summary", name: msg.name || "", videoId: msg.videoId, text: msg.text, html: msg.html });
    } else if (msg.type === "showError") {
      const info = describeError(msg.error);
      render({
        state: "error",
        title: msg.question ? "Answer unavailable" : "Summary unavailable",
        sub: msg.question || "",
        videoId: msg.videoId,
        text: info.message,
        reasons: info.reasons
      });
    }
  });

  // The "Ask" tool is a gated rollout, so a missing button is the common failure.
  // Rather than a cryptic one-liner, explain it and list why it might be missing.
  const ASK_UNAVAILABLE_REASONS = [
    "“Ask” requires YouTube Premium, and it's an experimental feature that's still rolling out — so it may not be on your account yet.",
    "You need to be signed in to YouTube in this browser.",
    "It isn't offered on every video — Shorts, live streams, music, kids', or age-restricted videos typically don't have it.",
    "The video may be private, removed, or unavailable in your region.",
    "The page may not have finished loading — try again in a moment.",
    "YouTube may have changed its layout, so the extension couldn't find the “Ask” button (it may need an update)."
  ];

  function describeError(reason) {
    switch (reason) {
      case "ask-not-found":
        return {
          message: "We couldn't retrieve the AI summary — YouTube's “Ask” tool wasn't available for this video.",
          reasons: ASK_UNAVAILABLE_REASONS
        };
      case "no-summarize-and-no-input":
        return {
          message: "We found “Ask” but couldn't start a summary.",
          reasons: [
            "YouTube may have changed the “Ask” panel, so the summarize prompt and text box weren't where we expected.",
            "The panel may not have finished loading — try again in a moment."
          ]
        };
      case "no-answer":
        return {
          message: "We asked for a summary, but no answer came back in time.",
          reasons: [
            "“Ask” can be slow on long videos — try again.",
            "The video may lack a transcript or captions for “Ask” to summarize.",
            "Your network or YouTube may be temporarily slow or rate-limiting."
          ]
        };
      case "no-hidden-tab":
        return {
          message: "We couldn't open YouTube in the background to fetch the summary.",
          reasons: [
            "The browser may have blocked opening a background window.",
            "Try opening the video and using the shortcut (Alt+Shift+S) on the watch page instead."
          ]
        };
      default:
        return {
          message: "We couldn't retrieve the AI summary" + (reason ? " (" + reason + ")" : "") + ".",
          reasons: [
            "YouTube's “Ask” may be unavailable for this video or account.",
            "The page may not have finished loading — try again in a moment.",
            "YouTube may have changed its layout, so the extension may need an update."
          ]
        };
    }
  }

  // --- Embedded summary card (watch page) --------------------------------
  // For a video we've already summarized, render OUR card inline where YouTube's
  // "Ask" card sits (styled to match it) instead of driving the native Ask panel.
  // The footer "Ask" button opens YouTube's real Ask panel and removes ours;
  // clicking YouTube's own "Ask" button anywhere does the same. Anchoring is
  // heuristic (the "Ask" markup is a gated experiment), with a safe fallback to the
  // top of the secondary column, and it never hides a non-card control.
  let embedHost = null;
  let embedHiddenCard = null; // a YouTube card we hid; restored when we tear down

  const SPARK_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<defs><linearGradient id="ytsumSpark" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#3ea6ff"></stop>' +
        '<stop offset="0.55" stop-color="#7e5cde"></stop>' +
        '<stop offset="1" stop-color="#e26296"></stop>' +
      '</linearGradient></defs>' +
      '<path fill="url(#ytsumSpark)" d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"></path>' +
    '</svg>';

  const emVisible = (el) => {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const emLabel = (el) =>
    ((el && (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title")) || el.textContent)) || "").trim();

  // True if YouTube's theme is dark. Read from the page's actual background
  // luminance rather than a `dark` attribute, whose host element varies by
  // YouTube version. Defaults to dark if it can't be determined.
  function pageIsDark() {
    try {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor || "");
      if (!m) return true;
      return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) < 128;
    } catch (_) { return true; }
  }

  // YouTube's "Ask" launcher, matched the same heuristic way askDriver does.
  function findAskButton() {
    const els = Array.from(document.querySelectorAll(
      'button, a, tp-yt-paper-button, yt-button-shape, [role="button"], ytd-button-renderer'
    )).filter(emVisible);
    return els.find((el) => {
      const t = emLabel(el);
      return t.length > 0 && t.length < 24 && /(^|\s)ask(\s|$)/i.test(t);
    }) || null;
  }

  // Where to mount: if YouTube's Ask launcher lives in the secondary column, find
  // the sidebar card holding it and replace that card; otherwise prepend to the top
  // of the secondary column. Only replaces a real, wide card (never a small inline
  // control), so a mis-detected "Ask" can't blow away the page layout.
  function findEmbedSlot() {
    const sec = document.querySelector("#secondary-inner") || document.querySelector("#secondary");
    const btn = findAskButton();
    if (btn && sec && sec.contains(btn)) {
      let c = btn;
      for (let i = 0; i < 8 && c.parentElement && c.parentElement !== sec; i++) c = c.parentElement;
      if (c && c.parentNode === sec && c.getBoundingClientRect().width > 250) {
        return { mode: "replace", card: c };
      }
    }
    if (sec) return { mode: "prepend", container: sec };
    return null;
  }

  function hideEmbed() {
    if (embedHiddenCard) {
      try { embedHiddenCard.style.removeProperty("display"); } catch (_) {}
      embedHiddenCard = null;
    }
    if (embedHost && embedHost.parentNode) embedHost.parentNode.removeChild(embedHost);
    embedHost = null;
  }

  // Restore YouTube's own card (so its Ask button is clickable), open the real Ask
  // panel, and remove our embedded card.
  function openRealAsk() {
    if (embedHiddenCard) { try { embedHiddenCard.style.removeProperty("display"); } catch (_) {} }
    const btn = findAskButton();
    hideEmbed();
    if (btn) { try { btn.click(); } catch (_) {} }
  }

  async function showEmbeddedSummary({ videoId, text, html }) {
    hideEmbed(); // clear any card left from a previous video
    // YouTube lazy-renders the watch page; wait briefly for a mount point, bailing
    // if the user navigates away meanwhile.
    let slot = null;
    for (let i = 0; i < 20; i++) {
      if (watchVideoId() !== videoId) return;
      slot = findEmbedSlot();
      if (slot) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!slot || watchVideoId() !== videoId) return;

    embedHost = document.createElement("div");
    embedHost.id = "ytsum-embed-root";
    if (!pageIsDark()) embedHost.classList.add("ytsum-light");
    embedHost.innerHTML = `
      <div class="ytsum-embed-card" role="region" aria-label="AI summary of this video">
        <div class="ytsum-embed-head">
          <span class="ytsum-embed-spark">${SPARK_SVG}</span>
          <span class="ytsum-embed-title">Summary</span>
        </div>
        <div class="ytsum-embed-body"></div>
        <div class="ytsum-embed-foot">
          <span class="ytsum-embed-note">AI-generated summary · may contain mistakes</span>
          <button class="ytsum-embed-ask" type="button">Ask</button>
        </div>
      </div>`;

    const body = embedHost.querySelector(".ytsum-embed-body");
    const rich = !!(html && renderRich(body, html, videoId));
    body.classList.toggle("ytsum-rich", rich);
    if (!rich) body.textContent = text || "";
    body.addEventListener("click", onTimestampClick); // seek the live player in place

    if (slot.mode === "replace") {
      embedHiddenCard = slot.card;
      slot.card.parentNode.insertBefore(embedHost, slot.card);
      slot.card.style.setProperty("display", "none", "important");
    } else {
      slot.container.insertBefore(embedHost, slot.container.firstChild);
    }
    embedHost.querySelector(".ytsum-embed-ask").addEventListener("click", openRealAsk);
  }

  // Ask the worker whether we already have this video's summary cached.
  function getCachedSummary(videoId) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "getCachedSummary", videoId }, (res) => {
          void chrome.runtime.lastError; // swallow "no response" when the worker is busy
          resolve(res || null);
        });
      } catch (_) { resolve(null); }
    });
  }

  // Clicking YouTube's own "Ask" button (anywhere outside our card) dismisses our
  // embedded summary, so the two never overlap.
  document.addEventListener("click", (e) => {
    if (!embedHost) return;
    const t = e.target;
    if (t && t.closest && t.closest("#ytsum-embed-root")) return; // our own UI
    const el = t && t.closest && t.closest('button, a, [role="button"], tp-yt-paper-button, yt-button-shape, ytd-button-renderer');
    if (!el) return;
    const lbl = emLabel(el);
    if (lbl.length > 0 && lbl.length < 24 && /(^|\s)ask(\s|$)/i.test(lbl)) hideEmbed();
  }, true);

  // --- 3. Auto-summarize on video page load ------------------------------
  // When the popup toggle is on, run the Ask → "Summarize this video" flow
  // automatically each time a watch page loads. YouTube is a single-page app,
  // so the two cases are handled separately: a hard load via the initial
  // storage read, and in-app navigations via "yt-navigate-finish" (fired by
  // YouTube itself once each navigation completes).
  const AUTO_KEY = "ytsum_autoSummarize";
  let autoEnabled = false;
  let lastAutoId = null; // last video we auto-triggered, so we fire once per video
  let autoTimer = null;

  chrome.storage.local.get(AUTO_KEY, (r) => {
    autoEnabled = !!r[AUTO_KEY];
    scheduleAuto(); // covers the initial hard load directly onto a watch page
  });

  // Reflect the popup toggle live, without needing a page reload. Turning it on
  // while already on a video summarizes that video right away.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && AUTO_KEY in changes) {
      autoEnabled = !!changes[AUTO_KEY].newValue;
      if (autoEnabled) scheduleAuto();
      else { hideEmbed(); lastAutoId = null; } // turned off: drop the card, allow re-show later
    }
  });

  // Fired by YouTube on every in-app (SPA) navigation, once the new page is ready.
  // Listen on both window and document since which one receives it has varied;
  // scheduleAuto is debounced + deduped, so catching it twice is harmless.
  window.addEventListener("yt-navigate-finish", scheduleAuto);
  document.addEventListener("yt-navigate-finish", scheduleAuto);

  function watchVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === "/watch") return u.searchParams.get("v");
    } catch (_) {}
    return null; // only regular /watch pages auto-summarize (not Shorts/feeds)
  }

  // Debounced: coalesces a burst of navigation events into a single trigger and
  // gives the new page a moment to settle before we drive its Ask UI.
  function scheduleAuto() {
    const id = watchVideoId();
    if (!id) { lastAutoId = null; hideEmbed(); return; } // left the watch page; allow re-fire on return
    if (!autoEnabled || id === lastAutoId) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(async () => {
      const now = watchVideoId();
      if (!autoEnabled || !now || now === lastAutoId) return;
      lastAutoId = now;
      hideEmbed(); // clear any card left from the previous video
      // Already summarized this one? Show our embedded card in place of YouTube's
      // "Ask" card and DON'T drive the native panel. Otherwise fall back to it.
      const cached = await getCachedSummary(now);
      if (now !== watchVideoId()) return; // navigated away during the lookup
      if (cached) { showEmbeddedSummary({ videoId: now, text: cached.text, html: cached.html }); return; }
      chrome.runtime.sendMessage({ type: "autoSummarize", videoId: now });
    }, 800);
  }
})();
