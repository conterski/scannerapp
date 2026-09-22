/* share-note.js — the message box above the page grid, sent ahead of the
 * scans, the switch that turns it off, and whether the message has gone yet.
 *
 * A share sheet can't put text ahead of files: WhatsApp drops text that
 * arrives with images, or at best captions the first one. So the message is
 * its own share, and since every share needs its own tap, the export buttons
 * take two: the message, then the scans. What is kept here is which of the
 * two the next tap will do.
 *
 * Exposes window.ShareNote.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // Off hides the box and makes the export a single tap again; the text is
  // kept, so switching back on brings it back as it was.
  const flag = PersistedFlag.create({
    storageKey: "scannerapp:messageBox",
    label: "message-box",
    defaultEnabled: true,
  });

  let onChange = () => {};
  let hasPagesToSend = false; // the list's say: the box only matters with pages under it
  let isMessageSent = false; // in the current export run

  /** The payment request with both dates set to today — read when the box is
   *  reset, so a fresh tab always starts on the day its batch begins. A saved
   *  tab keeps the date it was typed with. */
  function defaultNote() {
    const today = formatShortDate(new Date());
    return `Siang xxx, mohon bantuannya untuk pembayaran nota tanggal ${today} - ${today} dengan jumlah *Rp yyy*`;
  }

  /** d/m/yy, unpadded — the way the notes are dated by hand. */
  function formatShortDate(date) {
    return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear() % 100}`;
  }

  // ---------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------

  /** @param handlers { onChange } — called on every edit, with the box's
   *  current text available through get(). */
  function init(handlers) {
    onChange = handlers.onChange;
    const input = $("noteInput");
    input.addEventListener("input", () => {
      fitHeight(input);
      resetProgress(); // an edited message hasn't been sent
      onChange();
    });
    // Wired here rather than with the other settings in app.js: nothing but
    // this box reacts to it.
    flag.load();
    const check = $("messageCheck");
    check.checked = flag.isEnabled();
    check.addEventListener("change", () => {
      flag.setEnabled(check.checked);
      paint();
    });
    set(null);
  }

  /** The box as typed, for the store. */
  function get() { return $("noteInput").value; }

  /** Fills the box; null means the default. Sending starts over, since
   *  what's on screen is no longer what was shared. */
  function set(note) {
    const input = $("noteInput");
    input.value = note === null ? defaultNote() : note;
    fitHeight(input);
    resetProgress();
  }

  /** Whether there are pages to send the message ahead of. */
  function setVisible(visible) {
    hasPagesToSend = visible;
    paint();
  }

  /** The message the next tap should share, or null once it has gone (or
   *  there is none, or the box is switched off). */
  function nextUnsent() {
    const text = get().trim();
    return flag.isEnabled() && text && !isMessageSent ? text : null;
  }

  function markSent() {
    isMessageSent = true;
    showProgress("Message sent — tap Image or PDF again to send the scans.");
  }

  function resetProgress() {
    isMessageSent = false;
    showProgress("");
  }

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------

  /** A box measured while hidden reads as empty, so the fit is redone on
   *  showing. */
  function paint() {
    const showing = hasPagesToSend && flag.isEnabled();
    $("shareNote").hidden = !showing;
    if (showing) fitHeight($("noteInput"));
  }

  function showProgress(text) {
    const progress = $("noteProgress");
    progress.textContent = text;
    progress.hidden = !text;
  }

  /** Grows the box to its text — a textarea never scrolls inside itself here.
   *  Collapsing first lets it shrink again when lines are deleted. */
  function fitHeight(input) {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  window.ShareNote = { init, get, set, setVisible, nextUnsent, markSent, resetProgress };
})();
