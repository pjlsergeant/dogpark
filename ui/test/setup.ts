/**
 * The story tests render the same stories Storybook does, so they need the
 * same project annotations — decorators, parameters, the app's client — and a
 * couple of things jsdom does not implement.
 */
import { afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { setProjectAnnotations } from '@storybook/react-vite';
import preview from '../../.storybook/preview.js';

if (Element.prototype.scrollIntoView === undefined) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

// jsdom has the element but not the modal behaviour. Enough of it that the
// dialog opens and closes; how it looks is the browser's business.
if (HTMLDialogElement.prototype.showModal === undefined) {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.open = false;
  };
}

const annotations = setProjectAnnotations([preview]);

beforeAll(annotations.beforeAll);
afterEach(cleanup);
