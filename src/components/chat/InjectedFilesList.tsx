import { useState } from 'react';

/** Collapsible bar showing an injected file's path and content */
export function InjectedFileBar({
  file,
}: {
  file: { path: string; content: string; error?: boolean };
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`rounded border ${file.error ? 'border-red-200 bg-red-50/50' : 'border-gray-200 bg-gray-50'}`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium text-gray-600 hover:text-gray-800"
      >
        <span>{file.error ? '❌' : '📄'}</span>
        <span className="text-gray-400">{expanded ? '▼' : '▶'}</span>
        <span className="truncate">{file.path}</span>
      </button>
      {expanded && (
        <pre className="max-h-64 overflow-auto border-t border-gray-200 px-3 py-2 text-xs whitespace-pre-wrap text-gray-700">
          {file.content}
        </pre>
      )}
    </div>
  );
}

/** Render a list of InjectedFileBars */
export function InjectedFilesList({
  files,
}: {
  files: Array<{ path: string; content: string; error?: boolean }>;
}) {
  return (
    <div className="space-y-1">
      {files.map(f => (
        <InjectedFileBar key={f.path} file={f} />
      ))}
    </div>
  );
}
