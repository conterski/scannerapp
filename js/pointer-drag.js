/* pointer-drag.js — the pointerdown → move → up/cancel lifecycle shared by the
 * editor's corner handles, its edge handles and the page list's reorder grip.
 * Capturing the pointer keeps a drag tracking once the finger leaves the
 * element, and every listener the drag adds is removed when it ends.
 * Exposes window.PointerDrag.
 */
(function () {
  "use strict";

  /**
   * Makes `element` draggable.
   * @param element  the element the drag starts from
   * @param handlers { canStart?, onDragStart?, onDragMove, onDragEnd? } —
   *                 canStart declines the drag; the others receive the event
   */
  function startPointerDrag(element, handlers) {
    element.addEventListener("pointerdown", (event) => {
      if (handlers.canStart && !handlers.canStart()) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      if (handlers.onDragStart) handlers.onDragStart(event);

      const handleMove = (moveEvent) => handlers.onDragMove(moveEvent);
      const handleEnd = () => {
        element.removeEventListener("pointermove", handleMove);
        element.removeEventListener("pointerup", handleEnd);
        element.removeEventListener("pointercancel", handleEnd);
        if (handlers.onDragEnd) handlers.onDragEnd();
      };
      element.addEventListener("pointermove", handleMove);
      element.addEventListener("pointerup", handleEnd);
      element.addEventListener("pointercancel", handleEnd);
    });
  }

  window.PointerDrag = { startPointerDrag };
})();
