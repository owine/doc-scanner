import { describe, it, expect } from 'vitest';
import { anchorCandidates, anchorFolder, combineCandidates, matches } from '../../src/ui/inbox/choose.js';
import { makeDoc } from '../documents/fixtures.js';

describe('choose', () => {
  const current = makeDoc();
  const other = makeDoc();
  const sent = makeDoc({ possiblyInDrive: true });
  const noFolder = makeDoc({ analysis: { ...makeDoc().analysis!, folder: null } });
  const filed = makeDoc({ state: 'filed', filed: { name: 'Certified letter.pdf', folderPath: '/Legal', driveNodeUid: 'n', driveUrl: null } });

  it('offers other review cards that are not possibly in Drive for combining', () => {
    expect(combineCandidates(current, [current, other, sent]).map((d) => d.id)).toEqual([other.id]);
  });

  it('offers review cards with a folder, and filed documents with a name and folder, as anchors', () => {
    const c = anchorCandidates(current, [current, other, noFolder, sent], [filed, makeDoc({ state: 'filed', filed: null })]);
    expect(c.review.map((d) => d.id)).toEqual([other.id, sent.id]);
    expect(c.filed.map((d) => d.id)).toEqual([filed.id]);
  });

  it('labels an anchor by where it is or would be filed', () => {
    expect(anchorFolder(filed)).toBe('/Legal');
    expect(anchorFolder(other)).toBe('/Bills/Energy');
    expect(anchorFolder(noFolder)).toBeNull();
  });

  it('matches a search on name or folder, ignoring case', () => {
    expect(matches(filed, 'legal')).toBe(true);
    expect(matches(filed, 'CERTIFIED')).toBe(true);
    expect(matches(filed, 'water')).toBe(false);
    expect(matches(filed, '  ')).toBe(true);
  });
});
