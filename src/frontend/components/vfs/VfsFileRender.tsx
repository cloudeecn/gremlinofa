import { useMemo, useState } from 'react';
import { useViewOptions } from '../../hooks/useViewOptions';
import { handleCodeCopyClick } from '../../lib/clipboard';
import { renderMarkdownSafe } from '../../lib/markdownRenderer';
import { resolveLink } from '../../lib/vfsPath';
import type { RenderView } from '../../lib/vfsRenderView';

interface VfsFileRenderProps {
  view: RenderView;
  name: string;
  /** The file's folder, which relative links resolve against */
  dir: string;
  /** Text, or base64 for a binary image */
  content: string;
  /** A link to another memory file was clicked */
  onOpenLink: (path: string) => void;
}

/**
 * The Render tab. Memory files are written by the agent, so they get the
 * same distrust as its chat replies: Markdown goes through the chat's
 * sanitizer, and SVG is only ever drawn as an image.
 */
export default function VfsFileRender({
  view,
  name,
  dir,
  content,
  onOpenLink,
}: VfsFileRenderProps) {
  switch (view.kind) {
    case 'markdown':
      return <MarkdownRender content={content} dir={dir} onOpenLink={onOpenLink} />;
    case 'svg':
      // <img> runs no scripts and fetches nothing, so the SVG can't reach the
      // page or call home. A data: URL, not a blob: one: a blob URL shares the
      // app's origin, and "Open image in new tab" would run its scripts there.
      return (
        <ImageRender
          name={name}
          mime="image/svg+xml"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`}
          isEmpty={!content.trim()}
        />
      );
    case 'image':
      return (
        <ImageRender
          name={name}
          mime={view.mime}
          src={`data:${view.mime};base64,${content}`}
          isEmpty={!content}
        />
      );
  }
}

function EmptyFile() {
  return (
    <div className="flex-1 bg-gray-50 p-4">
      <p className="text-sm text-gray-400 italic">Empty file</p>
    </div>
  );
}

function ImageRender({
  name,
  mime,
  src,
  isEmpty,
}: {
  name: string;
  mime: string;
  src: string;
  isEmpty: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (isEmpty) return <EmptyFile />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-gray-50 p-6">
      {failed ? (
        <p className="text-sm text-gray-500">
          Couldn’t draw this image ({mime}). It may be damaged, or in a format this browser doesn’t
          support.
        </p>
      ) : (
        <img
          src={src}
          alt={name}
          onError={() => setFailed(true)}
          className="max-h-full max-w-full rounded border border-gray-200 bg-white shadow-sm"
        />
      )}
    </div>
  );
}

function MarkdownRender({
  content,
  dir,
  onOpenLink,
}: {
  content: string;
  dir: string;
  onOpenLink: (path: string) => void;
}) {
  const {
    options: { disableMath },
  } = useViewOptions();
  // A stable wrapper object: React 19 reassigns innerHTML for any new one.
  // `cache: false` keeps a large file out of the LRU that chat messages share.
  const html = useMemo(
    () => ({ __html: renderMarkdownSafe(content, { disableMath, cache: false }) }),
    [content, disableMath]
  );

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (handleCodeCopyClick(target)) {
      event.preventDefault();
      return;
    }
    const href = target.closest('a')?.getAttribute('href');
    if (!href) return;
    if (href.startsWith('#')) {
      // Headings carry no ids to jump to, and the hash router would read the
      // fragment as a route
      event.preventDefault();
      return;
    }
    const linked = resolveLink(dir, href);
    // Off-VFS links keep the sanitizer's target="_blank"
    if (linked === null) return;
    event.preventDefault();
    onOpenLink(linked);
  };

  if (!content.trim()) return <EmptyFile />;
  return (
    <div className="ios-scroll min-h-0 flex-1 overflow-auto overscroll-y-contain px-4 py-4 sm:px-6">
      <div
        className="prose prose-sm mx-auto max-w-3xl text-[15px] leading-relaxed"
        onClick={handleClick}
        dangerouslySetInnerHTML={html}
      />
    </div>
  );
}
