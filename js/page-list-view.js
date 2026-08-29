/* page-list-view.js — everything the page grid draws and handles: the cards,
 * their thumbnails and action buttons, drag-to-reorder, and select mode. It
 * owns no page data — it renders the array it is handed and reports what the
 * user did through the handlers given to init().
 * Exposes window.PageListView.
 */
(function () {
  "use strict";

  const GLYPH = {
    moveEarlier: "◀",
    moveLater: "▶",
    adjustCrop: "✂️",
    deletePage: "🗑",
    dragGrip: "≡",
    selected: "✓",
  };

  const $ = (id) => document.getElementById(id);

  let handlers = {};
  let isSelectModeActive = false;
  const selectedPageIds = new Set(); // page.id — stable across re-renders

  // ---------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------

  /** @param listHandlers { onEditPage, onDeletePage, onMovePage,
   *                        onDeleteSelected, onClearAll } */
  function init(listHandlers) {
    handlers = listHandlers;
    $("selectBtn").addEventListener("click", enterSelectMode);
    $("cancelSelectBtn").addEventListener("click", exitSelectMode);
    $("deleteSelectedBtn").addEventListener("click", () => handlers.onDeleteSelected());
    $("clearAllBtn").addEventListener("click", () => handlers.onClearAll());
  }

  function render(pages) {
    updateListChrome(pages);
    const grid = $("pageGrid");
    grid.innerHTML = "";
    pages.forEach((page, index) => {
      grid.appendChild(isSelectModeActive
        ? createSelectableCard(page, index)
        : createEditableCard(page, index, pages.length));
    });
  }

  /** Swaps one page's thumbnail in place — no full grid rebuild. */
  function refreshThumbnail(page) {
    if (!page.outputURL) return;
    const image = $("pageGrid").querySelector(`img[data-page-id="${page.id}"]`);
    if (image) image.src = page.outputURL;
  }

  function enterSelectMode() {
    isSelectModeActive = true;
    selectedPageIds.clear();
    handlers.onSelectModeChanged();
  }

  function exitSelectMode() {
    isSelectModeActive = false;
    selectedPageIds.clear();
    handlers.onSelectModeChanged();
  }

  function getSelectedPageIds() { return new Set(selectedPageIds); }

  /** The editor keeps the header visible, so its actions must step aside. */
  function setToolbarVisible(visible) { $("listToolbar").hidden = !visible; }

  // ---------------------------------------------------------------
  // Chrome around the grid
  // ---------------------------------------------------------------

  function updateListChrome(pages) {
    const hasPages = pages.length > 0;
    $("emptyState").hidden = hasPages;
    $("pdfBtn").disabled = !hasPages;
    $("photosBtn").disabled = !hasPages;
    $("listToolbar").hidden = !hasPages || isSelectModeActive;
    $("addBar").hidden = isSelectModeActive;
    $("exportBar").hidden = isSelectModeActive;
    $("exportHint").hidden = isSelectModeActive;
    $("compactToggle").hidden = isSelectModeActive;
    $("selectBar").hidden = !isSelectModeActive;
    if (isSelectModeActive) updateSelectBar();
  }

  function updateSelectBar() {
    const selectedCount = selectedPageIds.size;
    const deleteButton = $("deleteSelectedBtn");
    deleteButton.textContent = `Delete (${selectedCount})`;
    deleteButton.disabled = selectedCount === 0;
  }

  // ---------------------------------------------------------------
  // Cards
  // ---------------------------------------------------------------

  function createCardShell(index) {
    const card = document.createElement("div");
    card.className = "page-card";
    card.dataset.index = String(index);
    return card;
  }

  function createThumbnail(page, index) {
    const thumbnailWrap = document.createElement("div");
    thumbnailWrap.className = "page-thumb-wrap";
    const image = document.createElement("img");
    image.dataset.pageId = String(page.id);
    if (page.outputURL) image.src = page.outputURL; // a render may still be in flight
    image.alt = `Page ${index + 1}`;
    image.draggable = false;
    thumbnailWrap.appendChild(image);
    return thumbnailWrap;
  }

  function createPageNumber(index) {
    const number = document.createElement("span");
    number.className = "page-num";
    number.textContent = String(index + 1);
    return number;
  }

  function createSelectableCard(page, index) {
    const card = createCardShell(index);
    const thumbnailWrap = createThumbnail(page, index);
    thumbnailWrap.addEventListener("click", () => toggleSelected(page, card));
    card.classList.toggle("selected", selectedPageIds.has(page.id));

    const badge = document.createElement("span");
    badge.className = "select-badge";
    badge.textContent = GLYPH.selected;

    card.append(thumbnailWrap, createPageNumber(index), badge);
    return card;
  }

  function createEditableCard(page, index, pageCount) {
    const card = createCardShell(index);
    const thumbnailWrap = createThumbnail(page, index);
    thumbnailWrap.addEventListener("click", () => handlers.onEditPage(index));

    const grip = document.createElement("div");
    grip.className = "drag-grip";
    grip.textContent = GLYPH.dragGrip;
    attachReorderDrag(grip, card);

    card.append(thumbnailWrap, createPageNumber(index), grip,
      createPageActions(index, pageCount));
    return card;
  }

  function createActionButton(glyph, title, onClick) {
    const button = document.createElement("button");
    button.textContent = glyph;
    button.title = title;
    button.addEventListener("click", onClick);
    return button;
  }

  function createPageActions(index, pageCount) {
    const actions = document.createElement("div");
    actions.className = "page-actions";

    const moveEarlier = createActionButton(GLYPH.moveEarlier, "Move earlier",
      () => handlers.onMovePage(index, index - 1));
    moveEarlier.disabled = index === 0;

    const adjustCrop = createActionButton(GLYPH.adjustCrop, "Adjust crop",
      () => handlers.onEditPage(index));

    const moveLater = createActionButton(GLYPH.moveLater, "Move later",
      () => handlers.onMovePage(index, index + 1));
    moveLater.disabled = index === pageCount - 1;

    const deletePage = createActionButton(GLYPH.deletePage, "Delete page",
      () => handlers.onDeletePage(index));
    deletePage.className = "del-btn";

    actions.append(moveEarlier, adjustCrop, moveLater, deletePage);
    return actions;
  }

  /** Toggling the class directly keeps taps instant — no re-render per tap. */
  function toggleSelected(page, card) {
    if (selectedPageIds.has(page.id)) {
      selectedPageIds.delete(page.id);
      card.classList.remove("selected");
    } else {
      selectedPageIds.add(page.id);
      card.classList.add("selected");
    }
    updateSelectBar();
  }

  // ---------------------------------------------------------------
  // Drag to reorder
  // ---------------------------------------------------------------

  function cardUnderPointer(event, draggedCard) {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const card = element && element.closest(".page-card");
    return card && card !== draggedCard ? card : null;
  }

  function attachReorderDrag(grip, card) {
    let sourceIndex = -1;
    let cardUnderDrag = null;

    PointerDrag.startPointerDrag(grip, {
      onDragStart: () => {
        sourceIndex = parseInt(card.dataset.index, 10);
        card.classList.add("drag-source");
      },
      onDragMove: (event) => {
        const target = cardUnderPointer(event, card);
        if (cardUnderDrag && cardUnderDrag !== target) {
          cardUnderDrag.classList.remove("drag-over");
        }
        cardUnderDrag = target;
        if (cardUnderDrag) cardUnderDrag.classList.add("drag-over");
      },
      onDragEnd: () => {
        card.classList.remove("drag-source");
        if (cardUnderDrag) {
          const targetIndex = parseInt(cardUnderDrag.dataset.index, 10);
          cardUnderDrag.classList.remove("drag-over");
          cardUnderDrag = null;
          handlers.onMovePage(sourceIndex, targetIndex);
        }
        sourceIndex = -1;
      },
    });
  }

  window.PageListView = {
    init, render, refreshThumbnail,
    enterSelectMode, exitSelectMode, getSelectedPageIds, setToolbarVisible,
  };
})();
