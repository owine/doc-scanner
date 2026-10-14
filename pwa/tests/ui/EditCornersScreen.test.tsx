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
    fireEvent.click(screen.getAllByRole('button', { name: /cancel/i })[0]!);
    expect(onCancel).toHaveBeenCalled();
  });

  it('draws the corners as styled handles centred on their points', () => {
    const canvas = fakeCanvas();
    // Wrapper twice the canvas size: scale 2, no offsets.
    const w = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(canvas.width * 2);
    const h = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(canvas.height * 2);
    try {
      render(<EditCornersScreen canvas={canvas} initialQuad={VALID_QUAD} onCancel={() => {}} onApply={() => {}} />);
      for (const k of ['tl', 'tr', 'bl', 'br']) {
        expect(screen.getByLabelText(`Corner ${k}`)).toHaveClass('corner-handle');
      }
      const tl = screen.getByLabelText('Corner tl');
      expect(tl.style.left).toBe(`${VALID_QUAD.tl.x * 2 - 22}px`);
      expect(tl.style.top).toBe(`${VALID_QUAD.tl.y * 2 - 22}px`);
    } finally {
      w.mockRestore();
      h.mockRestore();
    }
  });

  it('offsets the handles by the letterbox when the wrapper is wider than the canvas', () => {
    const canvas = fakeCanvas();
    // Height-bound: scale 2, canvas drawn 2x wide, centred with offsetX of 100.
    const scale = 2;
    const wrapH = canvas.height * scale;
    const offsetX = 100;
    const w = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(canvas.width * scale + offsetX * 2);
    const h = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(wrapH);
    try {
      render(<EditCornersScreen canvas={canvas} initialQuad={VALID_QUAD} onCancel={() => {}} onApply={() => {}} />);
      const tl = screen.getByLabelText('Corner tl');
      expect(tl.style.left).toBe(`${VALID_QUAD.tl.x * scale + offsetX - 22}px`);
      expect(tl.style.top).toBe(`${VALID_QUAD.tl.y * scale - 22}px`);
    } finally {
      w.mockRestore();
      h.mockRestore();
    }
  });
});
