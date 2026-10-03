import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import VfsFileRender from '../VfsFileRender';
import type { RenderView } from '../../../lib/vfsRenderView';

const onOpenLink = vi.fn();

function renderView(view: RenderView, content: string, name = 'notes.md') {
  return render(
    <VfsFileRender view={view} name={name} dir="/notes" content={content} onOpenLink={onOpenLink} />
  );
}

const markdown = (content: string) => renderView({ kind: 'markdown' }, content);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('VfsFileRender', () => {
  describe('markdown', () => {
    it('renders headings, lists and code', () => {
      const { container } = markdown('# Plans\n\n- one\n- two\n\n```js\nlet x = 1;\n```');
      expect(screen.getByRole('heading', { level: 1, name: 'Plans' })).toBeInTheDocument();
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      expect(container.querySelector('.code-copy-button')).not.toBeNull();
    });

    it('sanitizes HTML the agent wrote into the file', () => {
      const { container } = markdown(
        '<script>alert(1)</script><img src="x" onerror="alert(2)"><div style="position:fixed">hi</div>'
      );
      expect(container.querySelector('script')).toBeNull();
      expect(container.querySelector('[onerror]')).toBeNull();
      expect(container.querySelector('[style]')).toBeNull();
      // A non-data image becomes a link instead of loading on render
      expect(container.querySelector('img')).toBeNull();
    });

    it('opens links to memory files inside the manager', () => {
      markdown('[todo](todo.md) [up](../top.md) [spaced](my%20file.md)');
      fireEvent.click(screen.getByRole('link', { name: 'todo' }));
      fireEvent.click(screen.getByRole('link', { name: 'up' }));
      fireEvent.click(screen.getByRole('link', { name: 'spaced' }));
      expect(onOpenLink.mock.calls).toEqual([
        ['/notes/todo.md'],
        ['/top.md'],
        ['/notes/my file.md'],
      ]);
    });

    it('leaves web links to the browser, in a new tab', () => {
      markdown('[site](https://example.com)');
      const link = screen.getByRole('link', { name: 'site' });
      expect(link).toHaveAttribute('target', '_blank');
      expect(fireEvent.click(link)).toBe(true);
      expect(onOpenLink).not.toHaveBeenCalled();
    });

    it('swallows fragment links instead of routing to them', () => {
      markdown('[jump](#section)');
      expect(fireEvent.click(screen.getByRole('link', { name: 'jump' }))).toBe(false);
      expect(onOpenLink).not.toHaveBeenCalled();
    });

    it('follows the chat’s Disable Math setting', () => {
      const { container, unmount } = markdown('Area: $x^2$');
      expect(container.querySelector('.katex')).not.toBeNull();
      unmount();

      localStorage.setItem('chatViewOptions', JSON.stringify({ disableMath: true }));
      const again = markdown('Area: $x^2$');
      expect(again.container.querySelector('.katex')).toBeNull();
      expect(again.container).toHaveTextContent('Area: $x^2$');
    });

    it('says when the file is empty', () => {
      markdown('  \n');
      expect(screen.getByText('Empty file')).toBeInTheDocument();
    });
  });

  describe('svg', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>';

    it('draws the SVG as an image from a data URL, never inline', () => {
      const { container } = renderView({ kind: 'svg' }, svg, 'logo.svg');
      const img = screen.getByRole('img', { name: 'logo.svg' });
      expect(img.getAttribute('src')).toBe(
        `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
      );
      expect(container.querySelector('svg')).toBeNull();
      expect(container.querySelector('script')).toBeNull();
    });

    it('explains an image the browser can’t draw', () => {
      renderView({ kind: 'svg' }, '<svg', 'broken.svg');
      fireEvent.error(screen.getByRole('img'));
      expect(screen.getByText(/Couldn’t draw this image \(image\/svg\+xml\)/)).toBeInTheDocument();
    });
  });

  it('draws a binary image with the mime it was given', () => {
    renderView({ kind: 'image', mime: 'image/bmp' }, 'Qk0=', 'old.bmp');
    expect(screen.getByRole('img', { name: 'old.bmp' })).toHaveAttribute(
      'src',
      'data:image/bmp;base64,Qk0='
    );
  });
});
