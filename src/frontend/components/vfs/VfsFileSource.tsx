import VfsButton from './VfsButton';

interface VfsFileSourceProps {
  /** Text, or base64 when `isBinary` */
  content: string;
  isBinary: boolean;
  mime: string;
  onDownload: () => void;
}

/** The Source tab: the text as stored, or a download for binary files */
export default function VfsFileSource({ content, isBinary, mime, onDownload }: VfsFileSourceProps) {
  if (!isBinary) {
    return (
      <div className="ios-scroll min-h-0 flex-1 overflow-auto overscroll-y-contain bg-gray-50 p-4">
        {content ? (
          <pre className="font-mono text-sm break-words whitespace-pre-wrap text-gray-800">
            {content}
          </pre>
        ) : (
          <p className="text-sm text-gray-400 italic">Empty file</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto bg-gray-50 p-6">
      <div
        aria-hidden="true"
        className="flex h-24 w-24 items-center justify-center rounded-lg bg-gray-200 text-4xl"
      >
        📄
      </div>
      <p className="text-sm text-gray-500">{mime} · no text preview</p>
      <VfsButton icon="⬇️" label="Download" tone="primary" onClick={onDownload} />
    </div>
  );
}
