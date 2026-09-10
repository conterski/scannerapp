/* choice-prompt.js — a modal that asks one question and offers a short list of
 * answers: where a batch of photos should go, or which camera to use.
 *
 * Buttons rather than a <select>. A native select inside this dialog could not
 * be changed at all on iPhone Safari — most likely because dismissing iOS's
 * picker wheel dispatches a click that reached the backdrop, closing the
 * dialog before the new value could be read. Buttons cannot fail that way, and
 * one tap replaces two. For the same reason a click on the backdrop no longer
 * dismisses; Cancel and Escape do, and they are unambiguous.
 *
 * `onChoose` runs synchronously inside the button's own click, so a choice may
 * open the file picker or the camera without losing the user gesture.
 *
 * Exposes window.ChoicePrompt.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  let elements = null;
  let onCancel = null; // set only while the dialog is open

  function init() {
    elements = {
      view: $("choicePrompt"),
      title: $("choicePromptTitle"),
      list: $("choicePromptList"),
      cancel: $("choicePromptCancelBtn"),
    };
    elements.cancel.addEventListener("click", cancel);
  }

  /**
   * @param options { title, choices, onCancel } — each choice is
   *                { label, onChoose, isDefault }; the default one is the one
   *                scrolled into view when the list is long enough to scroll.
   */
  function open(options) {
    // A prompt already on screen owns a caller waiting on its callbacks.
    // Cancel it rather than overwriting them, or that caller never hears back.
    cancel();
    elements.title.textContent = options.title;
    onCancel = options.onCancel || null;
    const defaultButton = fillChoices(options.choices);
    elements.view.hidden = false;
    document.addEventListener("keydown", onKeyDown);
    if (defaultButton) defaultButton.scrollIntoView({ block: "center" });
  }

  /** @returns the button marked as the default, if any */
  function fillChoices(choices) {
    const buttons = document.createDocumentFragment();
    let defaultButton = null;
    for (const choice of choices) {
      const button = createChoiceButton(choice);
      if (choice.isDefault) defaultButton = button;
      buttons.appendChild(button);
    }
    elements.list.replaceChildren(buttons);
    return defaultButton;
  }

  function createChoiceButton(choice) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-btn";
    if (choice.isDefault) button.classList.add("choice-btn--default");
    button.textContent = choice.label;
    // Close first: the handler may open a picker, and tearing the dialog down
    // afterwards would run outside the gesture that allows it.
    button.addEventListener("click", () => {
      close();
      choice.onChoose();
    });
    return button;
  }

  function onKeyDown(event) {
    if (event.key === "Escape") cancel();
  }

  function cancel() {
    const notify = onCancel;
    close();
    if (notify) notify();
  }

  /** Closes without notifying — every caller of this decides what to report. */
  function close() {
    if (elements.view.hidden) return;
    document.removeEventListener("keydown", onKeyDown);
    elements.view.hidden = true;
    elements.list.replaceChildren();
    onCancel = null;
  }

  window.ChoicePrompt = { init, open };
})();
