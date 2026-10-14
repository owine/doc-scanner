import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/preact';
import { Mark } from '../../src/ui/Mark.js';

describe('Mark', () => {
  it('is decorative and sized by its prop', () => {
    const { container } = render(<Mark size={30} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('width', '30');
    expect(svg).toHaveAttribute('height', '30');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg).toHaveClass('mark');
  });

  it('defaults to 22 and colours the dot through the accent token', () => {
    const { container } = render(<Mark />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '22');
    expect(container.querySelector('circle')!.style.fill).toBe('var(--accent)');
  });
});
