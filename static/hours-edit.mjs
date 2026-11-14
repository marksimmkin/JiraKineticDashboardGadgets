import { parseHoursInput } from './capacity.mjs';

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// The "Hours per working day" Edit view shared by Capacity, User List and User Leaderboard.
// The form always has the `hours-edit` class; `className` adds another. `submit` is view.submit;
// it saves `{ ...keep, hoursPerDay }` as the gadget configuration.
export function showHoursEditForm(root, { submit, idPrefix, className = '', heading, help, value, keep = {} }) {
  const inputId = `${idPrefix}-hours`;
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const form = node('form', className ? `panel hours-edit ${className}` : 'panel hours-edit');
  form.noValidate = true; // our own error message replaces the browser's validation bubble
  const title = node('h2', 'config-heading', heading);
  const label = node('label', 'field-label', 'Hours per working day');
  label.htmlFor = inputId;
  const input = node('input', 'text-input');
  input.id = inputId;
  // Text, not number: a number input reports '' for "7,5" in many locales; parseHoursInput validates.
  input.type = 'text';
  input.required = true;
  input.setAttribute('inputmode', 'decimal');
  input.setAttribute('aria-describedby', helpId);
  input.value = String(value);
  label.append(input);
  const helpText = node('p', 'muted', help);
  helpText.id = helpId;
  const error = node('p', 'error');
  error.id = errorId;
  error.setAttribute('role', 'alert');
  const save = node('button', 'button primary', 'Save settings');
  save.type = 'submit';
  form.append(title, label, helpText, error, save);
  root.replaceChildren(form);

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
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const hours = parseHoursInput(input.value);
    if (hours === null) {
      showError('Enter hours from 1 to 24, for example 7.5.');
      input.focus();
      return;
    }
    showError('');
    save.disabled = true;
    try {
      await submit({ ...keep, hoursPerDay: Number(hours) });
    } catch {
      error.textContent = 'Could not save the settings. Please try again.';
      save.disabled = false;
    }
  });
  return form;
}
