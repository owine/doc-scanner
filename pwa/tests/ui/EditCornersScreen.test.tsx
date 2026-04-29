import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';

beforeEach(() => cleanup());
import { EditCornersScreen } from '../../src/ui/EditCornersScreen.js';
import type { Quad } from '../../src/scanner/types.js';

function fakeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 400; c.height = 300;
  return c;
}

const VALID_QUAD: Quad = {
  tl: { x: 10, y: 10 }, tr: { x: 200, y: 10 },
  bl: { x: 10, y: 200 }, br: { x: 200, y: 200 },
};

const DEGENERATE_QUAD: Quad = {
  tl: { x: 100, y: 100 }, tr: { x: 100, y: 100 },
  bl: { x: 100, y: 100 }, br: { x: 100, y: 100 },
};

describe('EditCornersScreen', () => {
  it('renders Cancel and Apply buttons', () => {
    render(<EditCornersScreen canvas={fakeCanvas()} initialQuad={VALID_QUAD} onCancel={() => {}} onApply={() => {}} />);
    expect(screen.getAllByRole('button', { name: /cancel/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^apply$/i })).toBeInTheDocument();
  });

  it('Apply is disabled with degenerate quad', () => {
    render(<EditCornersScreen canvas={fakeCanvas()} initialQuad={DEGENERATE_QUAD} onCancel={() => {}} onApply={() => {}} />);
    expect(screen.getByRole('button', { name: /^apply$/i })).toBeDisabled();
  });

  it('Apply with valid quad calls onApply', () => {
    const onApply = vi.fn();
    render(<EditCornersScreen canvas={fakeCanvas()} initialQuad={VALID_QUAD} onCancel={() => {}} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    expect(onApply).toHaveBeenCalledWith(VALID_QUAD);
  });

  it('Cancel calls onCancel', () => {
    const onCancel = vi.fn();
    render(<EditCornersScreen canvas={fakeCanvas()} initialQuad={VALID_QUAD} onCancel={onCancel} onApply={() => {}} />);
    fireEvent.click(screen.getAllByRole('button', { name: /cancel/i })[0]);
    expect(onCancel).toHaveBeenCalled();
  });
});
