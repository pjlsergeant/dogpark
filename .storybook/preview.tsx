import type { Preview } from '@storybook/react-vite';
import { withDogpark } from '../ui/src/stories/harness.js';
import '../ui/src/styles.css';
import './canvas.css';

const preview: Preview = {
  decorators: [withDogpark],
  parameters: {
    layout: 'padded',
    controls: { expanded: true },
  },
};

export default preview;
