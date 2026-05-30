// popup.js — the extension's toolbar popup: settings + storage controls.

// Flash a button's label for a moment to confirm an action, then restore it.
function flash(btn, msg) {
  const lbl = btn.querySelector(".lbl") || btn;
  const orig = lbl.textContent;
  lbl.textContent = msg;
  setTimeout(() => { lbl.textContent = orig; }, 1200);
}

// --- Auto-summarize toggle -------------------------------------------------
// Persisted in chrome.storage.local; content.js reads the same key and reacts
// live via storage.onChanged, so flipping this takes effect without a reload.
const AUTO_KEY = "ytsum_autoSummarize";
const autoToggle = document.getElementById("autoToggle");
chrome.storage.local.get(AUTO_KEY, (r) => { autoToggle.checked = !!r[AUTO_KEY]; });
autoToggle.addEventListener("change", () => {
  chrome.storage.local.set({ [AUTO_KEY]: autoToggle.checked });
});

// --- Clear cached summaries ------------------------------------------------
// Summaries are cached by the worker (CACHE_KEY) so already-seen videos serve
// instantly. We show the live count and let the user wipe them; the worker owns
// the cache, so we go through it rather than touching storage directly.
const clearCache = document.getElementById("clearCache");
const cacheCount = document.getElementById("cacheCount");

function refreshCount() {
  chrome.runtime.sendMessage({ type: "getSummaryCount" }, (n) => {
    void chrome.runtime.lastError; // worker may be waking up
    const count = typeof n === "number" ? n : 0;
    cacheCount.textContent = count ? count + " saved" : "empty";
    clearCache.disabled = count === 0;
  });
}

clearCache.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clearSummaries" }, () => {
    void chrome.runtime.lastError;
    flash(clearCache, "Cleared!");
    refreshCount();
  });
});

// --- Reset popup size & location -------------------------------------------
// Clears the saved geometry; content.js observes the removal via storage.onChanged
// and snaps any open summary card back to its default top-right position/size.
const POPUP_KEY = "ytsum_popup";
const resetPopup = document.getElementById("resetPopup");
resetPopup.addEventListener("click", () => {
  chrome.storage.local.remove(POPUP_KEY, () => flash(resetPopup, "Reset!"));
});

// --- Footer ----------------------------------------------------------------
document.getElementById("ver").textContent = "v" + chrome.runtime.getManifest().version;
// chrome:// pages can't be opened by a normal link, so route the click through
// the tabs API to YouTube's spot in Chrome's keyboard-shortcuts settings.
document.getElementById("shortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

refreshCount();
