import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { ResumePrompt } from '../../src/ui/ResumePrompt.js';
import type { Scan } from '../../src/scanner/types.js';

const SCAN: Scan = {
  id: '01JXX',
  status: 'in_progress',
  pageCount: 3,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  thumbnailKey: null,
};

beforeEach(() => cleanup());

describe('ResumePrompt', () => {
  it('shows page count', () => {
    render(<ResumePrompt scan={SCAN} onResume={() => {}} onDiscard={() => {}} />);
    expect(screen.getByText(/3 pages/i)).toBeInTheDocument();
  });

  it('Resume calls onResume', () => {
    const onResume = vi.fn();
    render(<ResumePrompt scan={SCAN} onResume={onResume} onDiscard={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    expect(onResume).toHaveBeenCalled();
  });

  it('Discard calls onDiscard', () => {
    const onDiscard = vi.fn();
    render(<ResumePrompt scan={SCAN} onResume={() => {}} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(onDiscard).toHaveBeenCalled();
  });
});
