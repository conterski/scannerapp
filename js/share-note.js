/* share-note.js — the message box above the page grid, sent after the
 * scans, the switch that turns it off, and whether the scans have gone yet.
 *
 * A share sheet can't send text alongside files: WhatsApp drops text that
 * arrives with images, or at best captions the first one. So the message is
 * its own share, and since every share needs its own tap, the export buttons
 * take two: the scans, then the message. What is kept here is which of the
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
  let areScansSent = false; // in the current export run: the message's turn

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
      paint(); // emptied or refilled: whether a message is still due changes
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

  /** Fills the box; null means the default. A different tab's text: any run
   *  in progress belonged to the last one. */
  function set(note) {
    const input = $("noteInput");
    input.value = note === null ? defaultNote() : note;
    fitHeight(input);
    resetProgress();
  }

  /** Whether there are pages to send the message after. */
  function setVisible(visible) {
    hasPagesToSend = visible;
    paint();
  }

  /** The message the next tap should share: there is one once the scans have
   *  gone, while the box is on and has text. Read fresh each time, so the
   *  box can still be edited between the two taps. */
  function pendingMessage() {
    const text = get().trim();
    return areScansSent && flag.isEnabled() && text ? text : null;
  }

  /** The scans have been shared: the message, if any, is next. */
  function markScansSent() {
    areScansSent = true;
    paint();
  }

  /** The message has gone, or the run is over: the next tap exports again. */
  function resetProgress() {
    areScansSent = false;
    paint();
  }

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------

  /** The box, and under it the line saying the message is what the next tap
   *  sends. A box measured while hidden reads as empty, so the fit is redone
   *  on showing. */
  function paint() {
    const showing = hasPagesToSend && flag.isEnabled();
    $("shareNote").hidden = !showing;
    if (showing) fitHeight($("noteInput"));
    $("noteProgress").hidden = pendingMessage() === null;
  }

  /** Grows the box to its text — a textarea never scrolls inside itself here.
   *  Collapsing first lets it shrink again when lines are deleted. */
  function fitHeight(input) {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  window.ShareNote = { init, get, set, setVisible, pendingMessage, markScansSent, resetProgress };
})();
