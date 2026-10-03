import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Spinner from '../ui/Spinner';
import VfsDiffView from './VfsDiffView';
import type { VersionInfo, VfsAdapter } from '../../../shared/protocol/types/vfs';
import { computeLcsDiff, filterDiffContext, getDiffStats, splitLines } from '../../lib/lcsDiff';
import { formatTimestamp } from '../../lib/messageFormatters';

interface VfsHistoryProps {
  adapter: VfsAdapter;
  path: string;
  currentVersion: number;
  minStoredVersion: number;
  onRolledBack: () => void;
}

/** One step of history: `prev` is the version before (empty for the first stored one). */
interface VersionPair {
  version: number;
  prev: string;
  next: string;
}

const CONTEXT_LINES = 10;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Steps through a file's stored versions, one diff per step. Contents are
 * cached for the life of the tab, so stepping back and forth fetches each
 * version once. The previous diff stays up while the next one loads, and only
 * the latest step's result is shown.
 */
export default function VfsHistory({
  adapter,
  path,
  currentVersion,
  minStoredVersion,
  onRolledBack,
}: VfsHistoryProps) {
  const [fileId, setFileId] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [shown, setShown] = useState<VersionPair | null>(null);
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [contextOnly, setContextOnly] = useState(false);
  const [rolling, setRolling] = useState(false);

  const contentCacheRef = useRef(new Map<number, Promise<string>>());
  const requestIdRef = useRef(0);

  const loadPair = useCallback(
    async (id: string, version: number): Promise<VersionPair> => {
      const content = (v: number) => {
        let cached = contentCacheRef.current.get(v);
        if (!cached) {
          cached = adapter.getVersion(id, v).then(text => {
            if (text === null) throw new Error(`Version ${v} is missing`);
            return text;
          });
          // A failed fetch isn't cached, so Retry asks again
          cached.catch(() => contentCacheRef.current.delete(v));
          contentCacheRef.current.set(v, cached);
        }
        return cached;
      };
      const [next, prev] = await Promise.all([
        content(version),
        version > minStoredVersion ? content(version - 1) : '',
      ]);
      return { version, prev, next };
    },
    [adapter, minStoredVersion]
  );

  useEffect(() => {
    let cancelled = false;
    const requestId = ++requestIdRef.current;
    (async () => {
      try {
        const id = await adapter.getFileId(path);
        if (!id) throw new Error('File not found');
        const [list, pair] = await Promise.all([
          adapter.listVersions(id),
          loadPair(id, currentVersion),
        ]);
        if (cancelled || requestIdRef.current !== requestId) return;
        setFileId(id);
        setVersions(list);
        setShown(pair);
        setError(null);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, path, currentVersion, loadPair, attempt]);

  const show = (version: number) => {
    if (!fileId) return;
    const requestId = ++requestIdRef.current;
    setPendingVersion(version);
    setError(null);
    loadPair(fileId, version).then(
      pair => {
        if (requestIdRef.current !== requestId) return;
        setShown(pair);
        setPendingVersion(null);
      },
      loadError => {
        if (requestIdRef.current !== requestId) return;
        setError(errorMessage(loadError));
        setPendingVersion(null);
      }
    );
  };

  const rollback = async () => {
    if (!shown) return;
    setRolling(true);
    setError(null);
    try {
      // A new version with the old content: nothing in between is lost
      await adapter.writeFile(path, shown.next);
      onRolledBack();
    } catch (rollbackError) {
      setError(`Rollback failed: ${errorMessage(rollbackError)}`);
      setRolling(false);
    }
  };

  const diff = useMemo(() => {
    if (!shown || (!shown.prev && !shown.next)) return [];
    return computeLcsDiff(splitLines(shown.prev), splitLines(shown.next));
  }, [shown]);
  const stats = useMemo(() => getDiffStats(diff), [diff]);
  const hunks = useMemo(
    () => (contextOnly ? filterDiffContext(diff, CONTEXT_LINES) : null),
    [diff, contextOnly]
  );

  const versionOptions = useMemo(() => {
    const dates = new Map(versions.map(v => [v.version, v.createdAt]));
    const options: Array<{ version: number; createdAt: number }> = [];
    for (let v = currentVersion; v >= minStoredVersion; v--) {
      options.push({ version: v, createdAt: dates.get(v) ?? 0 });
    }
    return options;
  }, [versions, currentVersion, minStoredVersion]);

  if (!shown) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm">
        {error ? (
          <>
            <p className="text-red-600">Couldn’t load the history: {error}</p>
            <button
              type="button"
              className="text-blue-600 hover:underline"
              onClick={() => {
                setError(null);
                setAttempt(a => a + 1);
              }}
            >
              Retry
            </button>
          </>
        ) : (
          <Spinner size={24} className="text-gray-400" />
        )}
      </div>
    );
  }

  const target = pendingVersion ?? shown.version;
  const stepLabel =
    target === minStoredVersion
      ? minStoredVersion === 1
        ? 'Created'
        : 'Oldest stored'
      : 'Changes in';
  const navButtonClass =
    'flex h-8 w-8 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-200 disabled:opacity-30';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-200 bg-gray-50 px-4 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-gray-500">{stepLabel}</span>
          <button
            type="button"
            className={navButtonClass}
            onClick={() => show(target - 1)}
            disabled={target <= minStoredVersion}
            aria-label="Previous version"
            title="Previous version"
          >
            ◀
          </button>
          <select
            aria-label="Version"
            value={target}
            onChange={event => show(Number(event.target.value))}
            className="h-8 rounded border border-gray-300 bg-white px-2 text-sm text-gray-800"
          >
            {versionOptions.map(option => (
              <option key={option.version} value={option.version}>
                v{option.version}
                {option.createdAt > 0 ? ` · ${formatTimestamp(new Date(option.createdAt))}` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={navButtonClass}
            onClick={() => show(target + 1)}
            disabled={target >= currentVersion}
            aria-label="Next version"
            title="Next version"
          >
            ▶
          </button>
          {target === currentVersion && (
            <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">current</span>
          )}
          {pendingVersion !== null && <Spinner size={14} className="ml-1 text-gray-400" />}
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className="text-green-700">+{stats.added}</span>
          <span className="text-red-700">−{stats.removed}</span>
          <span className="text-gray-500">{stats.unchanged} unchanged</span>
          <button
            type="button"
            aria-pressed={contextOnly}
            onClick={() => setContextOnly(on => !on)}
            title={
              contextOnly
                ? 'Show the whole file'
                : `Show only ±${CONTEXT_LINES} lines around changes`
            }
            className={`rounded border px-1.5 py-0.5 transition-colors ${
              contextOnly
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-gray-300 text-gray-500 hover:bg-gray-100'
            }`}
          >
            ±{CONTEXT_LINES}
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      <div
        aria-busy={pendingVersion !== null}
        className={`min-h-0 flex-1 overflow-auto bg-white transition-opacity ${
          pendingVersion !== null ? 'opacity-60' : ''
        }`}
      >
        <VfsDiffView diff={diff} hunks={hunks} />
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-gray-200 bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={() => void rollback()}
          disabled={rolling || pendingVersion !== null || shown.version === currentVersion}
          title={
            shown.version === currentVersion
              ? 'This is the current version'
              : `Save v${shown.version}’s content as a new version`
          }
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-orange-600 px-4 text-sm font-medium text-white transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {rolling && <Spinner size={14} colorClass="border-white" />}
          Roll back to v{shown.version}
        </button>
      </div>
    </div>
  );
}
