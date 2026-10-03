import { describe, expect, it } from 'vitest';
import { renderViewFor } from '../vfsRenderView';

describe('renderViewFor', () => {
  it('renders text files by extension', () => {
    expect(renderViewFor('notes.md', false, 'text/plain')).toEqual({ kind: 'markdown' });
    expect(renderViewFor('README.MARKDOWN', false, 'text/plain')).toEqual({ kind: 'markdown' });
    expect(renderViewFor('logo.svg', false, 'text/plain')).toEqual({ kind: 'svg' });
  });

  it('has nothing to render for other text', () => {
    expect(renderViewFor('notes.txt', false, 'text/plain')).toBeNull();
    expect(renderViewFor('Makefile', false, 'text/plain')).toBeNull();
    expect(renderViewFor('page.html', false, 'text/plain')).toBeNull();
  });

  it('renders binary images by their sniffed mime', () => {
    expect(renderViewFor('photo', true, 'image/jpeg')).toEqual({
      kind: 'image',
      mime: 'image/jpeg',
    });
  });

  it('falls back to the extension when sniffing found nothing', () => {
    expect(renderViewFor('icon.ICO', true, 'application/octet-stream')).toEqual({
      kind: 'image',
      mime: 'image/x-icon',
    });
    expect(renderViewFor('archive.zip', true, 'application/zip')).toBeNull();
    expect(renderViewFor('blob', true, 'application/octet-stream')).toBeNull();
  });
});
