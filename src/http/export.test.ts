import { describe, expect, it } from 'vitest';
import { markdownLine, markdownText } from './export.js';

describe('generated markdown text', () => {
  it('escapes inline structure and flattens line breaks, keeping horizontal space', () => {
    expect(markdownText('report](evil.md')).toBe('report\\]\\(evil.md');
    expect(markdownText('Quarterly\n\n- injected')).toBe('Quarterly - injected');
    expect(markdownText('Quarterly  report')).toBe('Quarterly  report');
  });

  it('keeps own-line text from opening a list, a rule or a code block', () => {
    expect(markdownLine('- TODO')).toBe('\\- TODO');
    expect(markdownLine('1. on-call')).toBe('1\\. on-call');
    expect(markdownLine('---')).toBe('\\---');
    // CommonMark reads a marker behind up to three spaces, and a code block
    // behind four; leading whitespace means nothing on a line of its own.
    expect(markdownLine('   - TODO')).toBe('\\- TODO');
    expect(markdownLine('    looks like code')).toBe('looks like code');
  });
});
