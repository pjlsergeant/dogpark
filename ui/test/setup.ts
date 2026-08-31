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

const annotations = setProjectAnnotations([preview]);

beforeAll(annotations.beforeAll);
afterEach(cleanup);
