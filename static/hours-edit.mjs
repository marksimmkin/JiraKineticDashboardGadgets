import { parseHoursInput } from './capacity.mjs';

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export const HOURS_ERROR = 'Enter hours from 1 to 24, for example 7.5.';

// KDG-31: the "Hours per working day" field in the Controller's Edit settings. Returns
// { element, read() }. read() returns the valid number, or null after showing the error (with
// aria-invalid) and moving focus to the input. Typing clears the error.
export function createHoursField({ idPrefix, heading, help, value }) {
  const inputId = `${idPrefix}-hours`;
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const section = node('div', 'hours-edit');
  const title = node('h2', 'config-heading', heading);
  const label = node('label', 'field-label', 'Hours per working day');
  label.htmlFor = inputId;
  const input = node('input', 'text-input hours-input');
  input.id = inputId;
  // Text, not number: a number input reports '' for "7,5" in many locales; parseHoursInput validates.
  input.type = 'text';
  input.setAttribute('inputmode', 'decimal');
  input.setAttribute('aria-describedby', helpId);
  input.value = String(value);
  label.append(input);
  const helpText = node('p', 'muted', help);
  helpText.id = helpId;
  const error = node('p', 'error');
  error.id = errorId;
  error.setAttribute('role', 'alert');
  section.append(title, label, helpText, error);

  function showError(text) {
    error.textContent = text;
    if (text) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', `${helpId} ${errorId}`);
    } else {
      input.removeAttribute('aria-invalid');
      input.setAttribute('aria-describedby', helpId);
    }
  }

  input.addEventListener('input', () => { if (error.textContent) showError(''); });
  return {
    element: section,
    read({ focus = true } = {}) {
      const hours = parseHoursInput(input.value);
      if (hours === null) {
        showError(HOURS_ERROR);
        if (focus) input.focus();
        return null;
      }
      showError('');
      return Number(hours);
    },
  };
}
