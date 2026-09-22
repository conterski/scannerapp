/* share-notes.js — the two message boxes above the page grid, sent as one
 * message ahead of the scans, and whether that message has gone yet.
 *
 * A share sheet can't put text ahead of files: WhatsApp drops text that
 * arrives with images, or at best captions the first one. So the message is
 * its own share, and since every share needs its own tap, the export buttons
 * take two: the message, then the scans. What is kept here is which of the
 * two the next tap will do.
 *
 * Exposes window.ShareNotes.
 */
(function () {
  "use strict";

  const INPUT_IDS = ["noteInput1", "noteInput2"];

  const $ = (id) => document.getElementById(id);

  let onChange = () => {};
  let isMessageSent = false; // in the current export run

  /** Box 1 blank, box 2 the payment request with both dates set to today —
   *  read when the boxes are reset, so a fresh tab always starts on the day
   *  its batch begins. A saved tab keeps the dates it was typed with. */
  function defaultNotes() {
    const today = formatShortDate(new Date());
    return ["", `Siang, mohon bantuannya untuk pembayaran nota tanggal ${today} - ${today} dengan jumlah *Rp *`];
  }

  /** d/m/yy, unpadded — the way the notes are dated by hand. */
  function formatShortDate(date) {
    return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear() % 100}`;
  }

  // ---------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------

  /** @param handlers { onChange } — called on every edit, with the boxes'
   *  current text available through get(). */
  function init(handlers) {
    onChange = handlers.onChange;
    for (const input of inputs()) {
      input.addEventListener("input", () => {
        fitHeight(input);
        resetProgress(); // an edited message hasn't been sent
        onChange();
      });
    }
    set(null);
  }

  /** The boxes as typed, for the store. */
  function get() { return inputs().map((input) => input.value); }

  /** Fills the boxes; null means the defaults. Sending starts over, since
   *  what's on screen is no longer what was shared. */
  function set(notes) {
    const values = notes || defaultNotes();
    inputs().forEach((input, index) => {
      input.value = values[index] || "";
      fitHeight(input);
    });
    resetProgress();
  }

  /** Shown only while there are pages to send the messages ahead of. A box
   *  measured while hidden reads as empty, so the fit is redone on showing. */
  function setVisible(visible) {
    $("shareNotes").hidden = !visible;
    if (visible) inputs().forEach(fitHeight);
  }

  /** The two boxes as one message, a blank line between them; a blank box
   *  adds nothing, and two blank boxes make no message at all. */
  function message() {
    return get().map((text) => text.trim()).filter(Boolean).join("\n\n");
  }

  /** The message the next tap should share, or null once it has gone (or
   *  there is none). */
  function nextUnsent() {
    const text = message();
    return text && !isMessageSent ? text : null;
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

  function inputs() { return INPUT_IDS.map($); }

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

  window.ShareNotes = { init, get, set, setVisible, nextUnsent, markSent, resetProgress };
})();
