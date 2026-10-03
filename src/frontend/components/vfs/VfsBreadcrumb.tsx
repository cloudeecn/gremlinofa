import { Fragment } from 'react';
import { VFS_ROOT, ancestors, basename } from '../../lib/vfsPath';

interface VfsBreadcrumbProps {
  path: string;
  /** Opens an ancestor folder */
  onNavigate: (dir: string) => void;
}

/** `/ › notes › todo.md`: every ancestor is a link, the last segment is the current item. */
export default function VfsBreadcrumb({ path, onNavigate }: VfsBreadcrumbProps) {
  const crumbs = path === VFS_ROOT ? [] : ancestors(path);

  return (
    <nav aria-label="Path" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-0.5 text-sm">
        {crumbs.map(dir => (
          <Fragment key={dir}>
            <li className="min-w-0 shrink">
              <button
                type="button"
                onClick={() => onNavigate(dir)}
                aria-label={dir === VFS_ROOT ? 'Root folder' : undefined}
                className="block max-w-[12rem] truncate rounded px-1.5 py-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
              >
                {dir === VFS_ROOT ? '/' : basename(dir)}
              </button>
            </li>
            <li aria-hidden="true" className="shrink-0 text-gray-300">
              ›
            </li>
          </Fragment>
        ))}
        <li aria-current="page" className="min-w-0 truncate px-1.5 py-1 font-medium text-gray-900">
          {path === VFS_ROOT ? '/' : basename(path)}
        </li>
      </ol>
    </nav>
  );
}
