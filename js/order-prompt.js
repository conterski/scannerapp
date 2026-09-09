/* order-prompt.js — the "where should these photos go?" dialog shown after
 * photos are chosen from the library or a rapid-capture session ends.
 *
 * A dropdown rather than a typed page number: no invalid position can be
 * expressed, so there is nothing to clamp and no empty or out-of-range value
 * to handle. It defaults to the end, which is where photos have always gone.
 *
 * Exposes window.OrderPrompt. choosePosition() resolves with the index new
 * pages should be spliced in at, or null when the user cancels.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  let elements = null;
  let pending = null; // { resolve } while the dialog is open

  function init() {
    elements = {
      view: $("orderPrompt"),
      card: $("orderPromptCard"),
      title: $("orderPromptTitle"),
      select: $("orderPromptSelect"),
      confirm: $("orderPromptConfirmBtn"),
      cancel: $("orderPromptCancelBtn"),
    };
    elements.confirm.addEventListener("click", () => close(Number(elements.select.value)));
    elements.cancel.addEventListener("click", () => close(null));
    // A click that started and ended on the backdrop rather than the card.
    elements.view.addEventListener("click", (event) => {
      if (event.target === elements.view) close(null);
    });
  }

  /**
   * @param options { pageCount, photoCount } — how many pages exist, and how
   *                many are being added
   * @returns Promise<number|null> the index to insert at, or null if cancelled
   */
  function choosePosition(options) {
    const { pageCount, photoCount } = options;
    elements.title.textContent =
      `Add ${photoCount} photo${photoCount === 1 ? "" : "s"}`;
    fillPositions(pageCount);
    elements.view.hidden = false;
    document.addEventListener("keydown", onKeyDown);
    elements.select.focus();
    return new Promise((resolve) => { pending = { resolve }; });
  }

  /** One <option> per slot: before the first page, after each page, and after
   *  the last — which is the default, so confirming without touching the
   *  dropdown appends exactly as before this dialog existed. */
  function fillPositions(pageCount) {
    const options = document.createDocumentFragment();
    options.appendChild(createOption(0, "At the beginning"));
    for (let index = 1; index < pageCount; index++) {
      options.appendChild(createOption(index, `After page ${index}`));
    }
    options.appendChild(createOption(pageCount, `At the end (after page ${pageCount})`));
    elements.select.replaceChildren(options);
    elements.select.value = String(pageCount);
  }

  function createOption(value, label) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = label;
    return option;
  }

  function onKeyDown(event) {
    if (event.key === "Escape") close(null);
  }

  function close(position) {
    if (!pending) return;
    document.removeEventListener("keydown", onKeyDown);
    elements.view.hidden = true;
    const { resolve } = pending;
    pending = null;
    resolve(position);
  }

  window.OrderPrompt = { init, choosePosition };
})();
