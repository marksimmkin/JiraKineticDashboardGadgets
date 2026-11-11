// KDG-24: the read-only "Hiding:" note shown by gadgets that leave out statuses the Controller
// hides. The text comes from hiddenNote() in status-visibility.mjs; this module only builds DOM.
// It is not a live region.

// `element`, if given, is an existing <p> to use (the Counter builds its panel from a template).
export function createHiddenNote(element = document.createElement('p')) {
  element.className = 'muted status-hidden-note';
  element.hidden = true;

  // `note` is hiddenNote()'s result, or null to hide the note.
  function show(note) {
    element.removeAttribute('title');
    if (!note) {
      element.replaceChildren();
      element.hidden = true;
      return;
    }
    element.hidden = false;
    if (!note.truncated) {
      element.textContent = note.text;
      return;
    }
    // Truncated: the short line is for sighted users, the full sentence for screen readers.
    element.setAttribute('title', note.fullList);
    const visible = document.createElement('span');
    visible.setAttribute('aria-hidden', 'true');
    visible.textContent = note.text;
    const full = document.createElement('span');
    full.className = 'visually-hidden';
    full.textContent = note.fullText;
    element.replaceChildren(visible, full);
  }

  return { element, show };
}
