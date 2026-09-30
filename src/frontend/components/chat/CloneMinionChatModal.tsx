import { useMemo, useState } from 'react';
import Modal from '../ui/Modal';
import type { MinionChat } from '../../../shared/protocol/types';

interface CloneMinionChatModalProps {
  minionChat: MinionChat | null;
  messageCount: number;
  isCloning: boolean;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}

/** Matches `useProject.createNewChat`'s cap so the preview can't promise more. */
const MAX_NAME_LENGTH = 50;

const ignoreClose = () => {};

function defaultName(minionChat: MinionChat | null): string {
  const base = minionChat?.displayName ?? minionChat?.persona ?? 'Minion';
  return `${base} (clone)`.slice(0, MAX_NAME_LENGTH);
}

/**
 * Mounted only while open (see `MinionChatView`), so the name seeds once per
 * open from the current minion rather than needing an effect to re-sync it.
 */
export default function CloneMinionChatModal({
  minionChat,
  messageCount,
  isCloning,
  onCancel,
  onConfirm,
}: CloneMinionChatModalProps) {
  const [name, setName] = useState(() => defaultName(minionChat));

  const carried = useMemo(() => {
    if (!minionChat) return [];
    const rows: Array<[string, string]> = [];
    if (minionChat.persona) rows.push(['Persona', minionChat.persona]);
    if (minionChat.modelId) rows.push(['Model', minionChat.modelId]);
    const tools = minionChat.enabledTools?.filter(t => t !== 'return' && t !== 'minion') ?? [];
    rows.push(['Tools', tools.length > 0 ? tools.join(', ') : 'none']);
    rows.push(['Messages', String(messageCount)]);
    return rows;
  }, [minionChat, messageCount]);

  return (
    // A clone in flight can't be called back, so every close path waits for it
    <Modal isOpen onClose={isCloning ? ignoreClose : onCancel} size="lg" position="bottom">
      <div className="flex max-h-[85dvh] flex-col rounded-t-2xl bg-white md:max-h-[700px] md:rounded-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <h2 className="text-lg font-semibold text-gray-900">Clone to a Chat</h2>
          <button
            onClick={onCancel}
            disabled={isCloning}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center text-gray-600 transition-colors hover:text-gray-900 disabled:opacity-50"
          >
            <span className="text-2xl leading-none">✕</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
          <p className="text-sm text-gray-600">
            Copies this transcript into a chat you drive yourself, keeping the minion&apos;s
            persona, namespace, tools and model instead of the project&apos;s.
          </p>

          <div>
            <label htmlFor="clone-name" className="mb-1 block text-sm font-medium text-gray-700">
              Chat name
            </label>
            <input
              id="clone-name"
              type="text"
              value={name}
              maxLength={MAX_NAME_LENGTH}
              onChange={e => setName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
            />
          </div>

          <dl className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
            <div className="mb-2 font-medium text-gray-700">Carried over</div>
            {carried.map(([label, value]) => (
              <div key={label} className="flex gap-2 py-0.5">
                <dt className="w-24 shrink-0 text-gray-500">{label}</dt>
                <dd className="min-w-0 break-words text-gray-800">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
            The <code className="font-mono">return</code> tool is not copied — a regular chat
            replies to you directly. Any open <code className="font-mono">return</code> call is
            closed off in the copy.
          </div>

          {minionChat?.claudeAgentSessionId && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
              This minion runs on Claude Agent. The clone branches off its SDK session on the first
              message, and both keep their own history from there.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 p-4">
          <button
            onClick={onCancel}
            disabled={isCloning}
            className="h-11 rounded-lg px-4 text-base text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(name)}
            disabled={isCloning || !name.trim()}
            className="h-11 rounded-lg bg-blue-600 px-4 text-base font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isCloning ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
