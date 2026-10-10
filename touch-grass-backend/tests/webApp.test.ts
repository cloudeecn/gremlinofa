/// <reference lib="dom" />
/**
 * Runs static/app.js in jsdom on pages rendered by webViews. Timers and fetch are stubbed, so
 * each test drives the polls by hand.
 */
import fs from 'fs';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import type { InjectedFile, RequestRecord, Session, SessionMessage } from '../src/types.js';
import { chatPage, chatState, messagesFragment, sessionListPage } from '../src/webViews.js';

const APP_JS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/static/app.js'),
  'utf8'
);

const ORIGIN = 'https://grass.example';
const SESSION: Session = {
  id: 'abc123',
  callerId: 'test-caller',
  displayName: 'Deploy check',
  createdAt: '2026-10-08T10:00:00.000Z',
  lastActivityAt: '2026-10-08T10:00:00.000Z',
};

function pendingRequest(id: string): RequestRecord {
  return {
    id,
    sessionId: SESSION.id,
    messageId: 'm1',
    status: 'pending',
    responseMessageId: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    answeredAt: null,
    expiresAt: null,
    expireReason: null,
    expiredAt: null,
  };
}

type AudioState = 'suspended' | 'running';

/**
 * A stand-in for AudioContext. `startState` is what the browser's autoplay policy gives a
 * context made outside a click; `resumeAllowed: false` leaves resume() pending forever, the
 * way a browser holds it until the next gesture.
 */
function fakeAudio(startState: AudioState, resumeAllowed: boolean) {
  const audio = { contexts: 0, tones: 0 };

  class FakeAudioContext {
    state: AudioState = startState;
    currentTime = 0;
    destination = {};
    private listeners: Array<() => void> = [];

    constructor() {
      audio.contexts += 1;
    }

    addEventListener(_type: string, listener: () => void) {
      this.listeners.push(listener);
    }

    resume(): Promise<void> {
      if (!resumeAllowed) return new Promise(() => {});
      this.state = 'running';
      this.listeners.forEach(listener => listener());
      return Promise.resolve();
    }

    createOscillator() {
      return {
        frequency: { setValueAtTime() {} },
        connect() {},
        start: () => {
          audio.tones += 1;
        },
        stop() {},
      };
    }

    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
  }

  return { audio, FakeAudioContext };
}

interface OpenOptions {
  /** Path and query under ORIGIN. */
  url: string;
  sessionStorage?: Record<string, string>;
  localStorage?: Record<string, string>;
  audioStart?: AudioState;
  resumeAllowed?: boolean;
  /** A browser without the Web Audio API. */
  noAudio?: boolean;
}

/** The chat page polls every 3 s, the list every 5 s; shorter timers are something else. */
const POLL_INTERVAL_MIN_MS = 3000;

/** Lets fetch replies, resume() and the promise chains after a click settle. */
function settle() {
  return new Promise(resolve => setImmediate(resolve));
}

function openPage(html: string, options: OpenOptions) {
  const { window } = new JSDOM(html.replace(/<script [^>]*><\/script>/, ''), {
    url: ORIGIN + options.url,
    runScripts: 'outside-only',
  });
  for (const [key, value] of Object.entries(options.sessionStorage ?? {})) {
    window.sessionStorage.setItem(key, value);
  }
  for (const [key, value] of Object.entries(options.localStorage ?? {})) {
    window.localStorage.setItem(key, value);
  }

  const { audio, FakeAudioContext } = fakeAudio(
    options.audioStart ?? 'suspended',
    options.resumeAllowed ?? true
  );
  Object.assign(window, { AudioContext: options.noAudio ? undefined : FakeAudioContext });

  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const replies: unknown[] = [];
  Object.assign(window, {
    setTimeout: (callback: () => void, delay = 0) => scheduled.push({ callback, delay }),
    setInterval: () => 0,
    fetch: async () => {
      const reply = replies.shift();
      return { status: 200, ok: true, json: async () => reply };
    },
  });

  window.eval(APP_JS);

  return {
    window,
    document: window.document,
    audio,
    /** Runs the poll app.js scheduled, answering its fetch with `reply`. */
    async poll(reply: unknown) {
      replies.push(reply);
      const index = scheduled.findIndex(timer => timer.delay >= POLL_INTERVAL_MIN_MS);
      expect(index).not.toBe(-1);
      scheduled.splice(index, 1)[0].callback();
      await settle();
    },
    /** Runs every timer shorter than a poll interval, as if a few seconds had passed. */
    elapse() {
      const due = scheduled.filter(timer => timer.delay < POLL_INTERVAL_MIN_MS);
      due.forEach(timer => scheduled.splice(scheduled.indexOf(timer), 1));
      due.forEach(timer => timer.callback());
    },
  };
}

interface ChatHtmlOptions {
  pendingId?: string;
  othersPending?: string[];
  /** What the server puts back in the box after refusing an answer. */
  draft?: string;
  messages?: SessionMessage[];
}

function chatHtml({ pendingId, othersPending = [], draft, messages = [] }: ChatHtmlOptions = {}) {
  return chatPage({
    base: '../',
    session: SESSION,
    messages,
    state: chatState(pendingId ? pendingRequest(pendingId) : undefined, messages.at(-1)),
    othersPending,
    draft,
  });
}

function chatUpdate(pendingId: string | null, othersPending: string[] = []) {
  return {
    html: '',
    count: 0,
    pending: pendingId ? { requestId: pendingId, expiresAt: null } : null,
    othersPending,
    statusHtml: 'status',
  };
}

const CHAT_URL = `/grass/web/sessions/${SESSION.id}`;
const DRAFT_KEY = `tg:draft:${SESSION.id}`;
const SENT_KEY = `tg:sent:${SESSION.id}`;
const SOUND_ON = { 'tg:sound': 'on' };

function element<T extends HTMLElement>(page: { document: Document }, id: string): T {
  const found = page.document.getElementById(id);
  expect(found).not.toBeNull();
  return found as T;
}

describe('sound', () => {
  function soundSwitch(page: { document: Document }) {
    const button = element<HTMLButtonElement>(page, 'sound-toggle');
    return {
      button,
      state: () => button.dataset.state,
      label: () => button.querySelector('.sound-label')!.textContent,
    };
  }

  it('beeps for the next question on a fresh page when the browser lets audio run', async () => {
    // After a send, the chat page loads anew; Chrome lets a context made at load run.
    const page = openPage(chatHtml(), {
      url: CHAT_URL,
      localStorage: SOUND_ON,
      audioStart: 'running',
    });
    expect(page.audio.contexts).toBe(1);
    expect(soundSwitch(page).state()).toBe('on');
    await page.poll(chatUpdate('r2'));
    expect(page.audio.tones).toBe(1);
  });

  it('reads a new suspended context as starting, then blocked, then on once it resumes', async () => {
    // Firefox and Safari start every context suspended, even where audio is allowed.
    const page = openPage(chatHtml(), { url: CHAT_URL, localStorage: SOUND_ON });
    const sound = soundSwitch(page);
    expect(sound.state()).toBe('on');

    page.elapse();
    expect(sound.state()).toBe('blocked');
    expect(sound.label()).toBe('Click to enable sound');

    await page.poll(chatUpdate('r2'));
    expect(page.audio.tones).toBe(1);
    expect(sound.state()).toBe('on');
    expect(sound.label()).toBe('Sound on');
  });

  it('stays quiet and blocked while the browser holds audio back', async () => {
    const page = openPage(chatHtml(), {
      url: CHAT_URL,
      localStorage: SOUND_ON,
      resumeAllowed: false,
    });
    page.elapse();
    await page.poll(chatUpdate('r2'));
    expect(page.audio.tones).toBe(0);
    expect(soundSwitch(page).state()).toBe('blocked');
  });

  // A touch counts as a gesture only from pointerup / touchend; a mouse from pointerdown.
  it.each(['pointerdown', 'pointerup', 'touchend', 'keydown'])(
    'unblocks on a %s anywhere on the page',
    async type => {
      const page = openPage(chatHtml(), { url: CHAT_URL, localStorage: SOUND_ON });
      page.elapse();
      const message = page.document.getElementById('chat-status')!;
      message.dispatchEvent(new page.window.Event(type, { bubbles: true }));
      await settle();
      expect(soundSwitch(page).state()).toBe('on');
    }
  );

  it('makes no audio context while sound is off', async () => {
    const page = openPage(chatHtml(), { url: CHAT_URL, audioStart: 'running' });
    await page.poll(chatUpdate('r2'));
    expect(page.audio.contexts).toBe(0);
    expect(soundSwitch(page).state()).toBe('off');
  });

  it('turns on from off with a sample beep, and back off', async () => {
    const page = openPage(chatHtml(), { url: CHAT_URL, audioStart: 'running' });
    const sound = soundSwitch(page);
    sound.button.click();
    await settle();
    expect(sound.state()).toBe('on');
    expect(page.window.localStorage.getItem('tg:sound')).toBe('on');
    expect(page.audio.tones).toBe(1);

    sound.button.click();
    await settle();
    expect(sound.state()).toBe('off');
    expect(sound.label()).toBe('Sound off');
    expect(page.window.localStorage.getItem('tg:sound')).toBe('off');
    expect(page.audio.tones).toBe(1);
  });

  it('turns on when the blocked switch itself is clicked or tapped', async () => {
    // A real click or tap starts with pointerdown and pointerup (plus touchend). If those
    // unlocked audio, the switch would read as on by the time the click landed, and the click
    // would turn sound off.
    const page = openPage(chatHtml(), { url: CHAT_URL, localStorage: SOUND_ON });
    page.elapse();
    const sound = soundSwitch(page);
    expect(sound.state()).toBe('blocked');
    for (const type of ['pointerdown', 'pointerup', 'touchend']) {
      sound.button.dispatchEvent(new page.window.Event(type, { bubbles: true }));
    }
    await settle();
    sound.button.click();
    await settle();
    expect(sound.state()).toBe('on');
    expect(page.window.localStorage.getItem('tg:sound')).toBe('on');
    expect(page.audio.tones).toBe(1);
  });

  it('stays hidden without the Web Audio API', () => {
    const page = openPage(chatHtml(), { url: CHAT_URL, localStorage: SOUND_ON, noAudio: true });
    expect(soundSwitch(page).button.hidden).toBe(true);
  });
});

describe('drafts', () => {
  it('drops the draft once the server confirms the send, and tidies the URL', () => {
    const page = openPage(chatHtml(), {
      url: `${CHAT_URL}?sent=r1`,
      sessionStorage: { [DRAFT_KEY]: 'yes, ship it', [SENT_KEY]: 'r1' },
    });
    expect(element<HTMLTextAreaElement>(page, 'response-input').value).toBe('');
    expect(page.window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(page.window.location.href).toBe(ORIGIN + CHAT_URL);
  });

  it('keeps the draft when the send never arrived and the question has since gone', () => {
    // Send hit a proxy 502; meanwhile the AI cancelled, so nothing is pending now.
    const page = openPage(chatHtml(), {
      url: CHAT_URL,
      sessionStorage: { [DRAFT_KEY]: 'a long careful answer', [SENT_KEY]: 'r1' },
    });
    expect(element<HTMLTextAreaElement>(page, 'response-input').value).toBe(
      'a long careful answer'
    );
    expect(page.window.sessionStorage.getItem(DRAFT_KEY)).toBe('a long careful answer');
    expect(page.window.sessionStorage.getItem(SENT_KEY)).toBeNull();
    const banner = element(page, 'chat-banner');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('may not have reached the server');
  });

  it('keeps the draft without a banner when the same question is still open', () => {
    const page = openPage(chatHtml({ pendingId: 'r1' }), {
      url: CHAT_URL,
      sessionStorage: { [DRAFT_KEY]: 'retry me', [SENT_KEY]: 'r1' },
    });
    expect(element<HTMLTextAreaElement>(page, 'response-input').value).toBe('retry me');
    expect(element(page, 'chat-banner').hidden).toBe(true);
  });

  it('keeps the draft when the confirmation names another send', () => {
    const page = openPage(chatHtml({ pendingId: 'r2' }), {
      url: `${CHAT_URL}?sent=r1`,
      sessionStorage: { [DRAFT_KEY]: 'answer for r2', [SENT_KEY]: 'r2' },
    });
    expect(element<HTMLTextAreaElement>(page, 'response-input').value).toBe('answer for r2');
  });

  it('stores the draft the server put back after refusing it', () => {
    const page = openPage(chatHtml({ pendingId: 'r2', draft: 'refused text' }), {
      url: CHAT_URL,
      sessionStorage: { [SENT_KEY]: 'r1' },
    });
    expect(page.window.sessionStorage.getItem(DRAFT_KEY)).toBe('refused text');
  });
});

describe('session list alerts', () => {
  function listHtml(pendingIds: string[]) {
    return sessionListPage({ base: './', listHtml: '', pendingIds, signature: 's' });
  }

  function listUpdate(pendingIds: string[]) {
    return { html: '', pendingIds, signature: 's' };
  }

  it('alerts when a new question replaces another between two polls', async () => {
    const page = openPage(listHtml(['a', 'b']), {
      url: '/grass/web/',
      localStorage: SOUND_ON,
      audioStart: 'running',
    });
    await page.poll(listUpdate(['a', 'c']));
    expect(page.audio.tones).toBe(1);
    expect(page.document.title).toBe('(2) Touch Grass');

    await page.poll(listUpdate(['a', 'c']));
    expect(page.audio.tones).toBe(1);
  });

  it('stays quiet when a question goes away', async () => {
    const page = openPage(listHtml(['a', 'b']), {
      url: '/grass/web/',
      localStorage: SOUND_ON,
      audioStart: 'running',
    });
    await page.poll(listUpdate(['a']));
    expect(page.audio.tones).toBe(0);
    expect(page.document.title).toBe('(1) Touch Grass');
  });
});

describe('chat page alerts for other sessions', () => {
  it('shows the alert toggles', () => {
    const page = openPage(chatHtml(), { url: CHAT_URL });
    expect(element(page, 'sound-toggle').hidden).toBe(false);
  });

  it('alerts, counts and badges a question from another session', async () => {
    const page = openPage(chatHtml(), {
      url: CHAT_URL,
      localStorage: SOUND_ON,
      audioStart: 'running',
    });
    const badge = element(page, 'others-waiting');
    expect(badge.hidden).toBe(true);

    await page.poll(chatUpdate(null, ['x']));
    expect(page.audio.tones).toBe(1);
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('1 other waiting');
    expect(page.document.title).toBe('(1) Deploy check - Touch Grass');

    // This session's own question adds to the count; one beep per poll.
    await page.poll(chatUpdate('r1', ['x', 'y']));
    expect(page.audio.tones).toBe(2);
    expect(badge.textContent).toBe('2 others waiting');
    expect(page.document.title).toBe('(3) Deploy check - Touch Grass');
  });
});

describe('file view toggle', () => {
  function fileMessage(id: string, path: string): SessionMessage {
    return {
      id,
      sessionId: SESSION.id,
      role: 'ai',
      content: 'Look at this',
      files: [{ path, content: '# Heading', placement: 'before' }],
      createdAt: '2026-10-08T10:00:00.000Z',
      awaitsReply: true,
    };
  }

  function views(block: Element) {
    return {
      toggle: block.querySelector<HTMLButtonElement>('.view-toggle')!,
      raw: block.querySelector<HTMLElement>('.file-raw')!,
      rendered: block.querySelector<HTMLElement>('.file-markdown')!,
    };
  }

  it('flips between raw and rendered, both ways', () => {
    const page = openPage(chatHtml({ messages: [fileMessage('m1', 'a.txt')] }), { url: CHAT_URL });
    const { toggle, raw, rendered } = views(page.document.querySelector('.file-block')!);
    expect([raw.hidden, rendered.hidden]).toEqual([false, true]);

    toggle.click();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect([raw.hidden, rendered.hidden]).toEqual([true, false]);

    toggle.click();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect([raw.hidden, rendered.hidden]).toEqual([false, true]);
  });

  it('works on files that arrive with a chat update', async () => {
    const page = openPage(chatHtml(), { url: CHAT_URL });
    await page.poll({
      ...chatUpdate(null),
      html: messagesFragment([fileMessage('m1', 'notes.md')]),
      count: 1,
    });
    const { toggle, raw, rendered } = views(page.document.querySelector('.file-block')!);
    expect([raw.hidden, rendered.hidden]).toEqual([true, false]);
    toggle.click();
    expect([raw.hidden, rendered.hidden]).toEqual([false, true]);
  });
});

describe('message view toggle', () => {
  function messageViews(message: Element) {
    return {
      toggle: message.querySelector<HTMLButtonElement>(':scope > .message-meta > .view-toggle')!,
      raw: message.querySelector<HTMLElement>(':scope > .message-content')!,
      rendered: message.querySelector<HTMLElement>(':scope > .message-markdown')!,
    };
  }

  const markdownMessage: SessionMessage = {
    id: 'm1',
    sessionId: SESSION.id,
    role: 'ai',
    content: '# Plan',
    files: [{ path: 'a.md', content: '# File', placement: 'after' }],
    createdAt: '2026-10-08T10:00:00.000Z',
    awaitsReply: true,
  };

  it('opens rendered and flips to raw and back', () => {
    const page = openPage(chatHtml({ messages: [markdownMessage] }), { url: CHAT_URL });
    const { toggle, raw, rendered } = messageViews(page.document.querySelector('.message')!);
    expect(rendered.innerHTML).toBe('<h1>Plan</h1>\n');
    expect([raw.hidden, rendered.hidden]).toEqual([true, false]);

    toggle.click();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect([raw.hidden, rendered.hidden]).toEqual([false, true]);

    toggle.click();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect([raw.hidden, rendered.hidden]).toEqual([true, false]);
  });

  it('flips the message and its files independently', () => {
    const page = openPage(chatHtml({ messages: [markdownMessage] }), { url: CHAT_URL });
    const message = messageViews(page.document.querySelector('.message')!);
    const fileBlock = page.document.querySelector('.file-block')!;
    const fileRaw = fileBlock.querySelector<HTMLElement>('.file-raw')!;
    expect(fileRaw.hidden).toBe(true);

    message.toggle.click();
    expect(message.raw.hidden).toBe(false);
    expect(fileRaw.hidden).toBe(true);

    fileBlock.querySelector<HTMLButtonElement>('.view-toggle')!.click();
    expect(fileRaw.hidden).toBe(false);
    expect(message.raw.hidden).toBe(false);
  });

  it('works on messages that arrive with a chat update', async () => {
    const page = openPage(chatHtml(), { url: CHAT_URL });
    await page.poll({
      ...chatUpdate('r1'),
      html: messagesFragment([markdownMessage]),
      count: 1,
    });
    const { toggle, raw, rendered } = messageViews(page.document.querySelector('.message')!);
    expect([raw.hidden, rendered.hidden]).toEqual([true, false]);
    toggle.click();
    expect([raw.hidden, rendered.hidden]).toEqual([false, true]);
  });
});

describe('character count', () => {
  function type(page: ReturnType<typeof openPage>, text: string) {
    const input = element<HTMLTextAreaElement>(page, 'response-input');
    input.value = text;
    input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  }

  it('follows what the human types, counting an emoji as one character', () => {
    const page = openPage(chatHtml({ pendingId: 'r1' }), { url: CHAT_URL });
    const count = element(page, 'char-count');
    expect(count.textContent).toBe('0 characters');

    type(page, 'y');
    expect(count.textContent).toBe('1 character');

    type(page, 'yes 👍\nship it');
    expect(count.textContent).toBe('13 characters');
  });

  it('counts a draft restored from an earlier visit', () => {
    const page = openPage(chatHtml({ pendingId: 'r1' }), {
      url: CHAT_URL,
      sessionStorage: { [DRAFT_KEY]: 'half an answer' },
    });
    expect(element(page, 'char-count').textContent).toBe('14 characters');
  });
});

function chatMessage(
  id: string,
  role: SessionMessage['role'],
  files: InjectedFile[] | null = null
): SessionMessage {
  return {
    id,
    sessionId: SESSION.id,
    role,
    content: `${role} says ${id}`,
    files,
    createdAt: '2026-10-08T10:00:00.000Z',
    awaitsReply: role === 'ai',
  };
}

const NOTES_FILE: InjectedFile = { path: 'notes.md', content: '# Notes', placement: 'before' };
const AUTO_EXPAND_ON = { 'tg:auto-expand': 'on' };

describe('auto-expand files', () => {
  function fileBlocksOpen(page: { document: Document }) {
    return [...page.document.querySelectorAll<HTMLDetailsElement>('.file-block')].map(
      block => block.open
    );
  }

  it('starts unchecked with files collapsed', () => {
    const page = openPage(chatHtml({ messages: [chatMessage('m1', 'ai', [NOTES_FILE])] }), {
      url: CHAT_URL,
    });
    expect(element<HTMLInputElement>(page, 'auto-expand-files').checked).toBe(false);
    expect(fileBlocksOpen(page)).toEqual([false]);
  });

  it('opens every file at load when it was left on', () => {
    const messages = [chatMessage('m1', 'ai', [NOTES_FILE]), chatMessage('m2', 'ai', [NOTES_FILE])];
    const page = openPage(chatHtml({ messages }), { url: CHAT_URL, localStorage: AUTO_EXPAND_ON });
    expect(element<HTMLInputElement>(page, 'auto-expand-files').checked).toBe(true);
    expect(fileBlocksOpen(page)).toEqual([true, true]);
  });

  it('opens and collapses the files on the page, and remembers the choice', () => {
    const page = openPage(chatHtml({ messages: [chatMessage('m1', 'ai', [NOTES_FILE])] }), {
      url: CHAT_URL,
    });
    const box = element<HTMLInputElement>(page, 'auto-expand-files');
    box.click();
    expect(fileBlocksOpen(page)).toEqual([true]);
    expect(page.window.localStorage.getItem('tg:auto-expand')).toBe('on');

    box.click();
    expect(fileBlocksOpen(page)).toEqual([false]);
    expect(page.window.localStorage.getItem('tg:auto-expand')).toBe('off');
  });

  it('opens files that arrive with a chat update', async () => {
    const page = openPage(chatHtml(), { url: CHAT_URL, localStorage: AUTO_EXPAND_ON });
    await page.poll({
      ...chatUpdate('r1'),
      html: messagesFragment([chatMessage('m1', 'ai', [NOTES_FILE])]),
      count: 1,
    });
    expect(fileBlocksOpen(page)).toEqual([true]);
  });

  it('leaves arriving files collapsed while off', async () => {
    const page = openPage(chatHtml(), { url: CHAT_URL });
    await page.poll({
      ...chatUpdate('r1'),
      html: messagesFragment([chatMessage('m1', 'ai', [NOTES_FILE])]),
      count: 1,
    });
    expect(fileBlocksOpen(page)).toEqual([false]);
  });
});

describe('chat menu', () => {
  function openMenu() {
    const page = openPage(chatHtml({ messages: [chatMessage('m1', 'ai', [NOTES_FILE])] }), {
      url: CHAT_URL,
    });
    const menu = page.document.getElementById('chat-menu') as HTMLDetailsElement;
    menu.open = true;
    return { page, menu };
  }

  it('stays open while its own items are used', () => {
    const { page, menu } = openMenu();
    const box = element(page, 'auto-expand-files');
    box.dispatchEvent(new page.window.Event('pointerdown', { bubbles: true }));
    box.click();
    expect(menu.open).toBe(true);
  });

  it('closes on a press outside, without touching file blocks', () => {
    // A press on plain text: iOS Safari sends pointerdown for it, but no click.
    const { page, menu } = openMenu();
    const fileBlock = page.document.querySelector<HTMLDetailsElement>('.file-block')!;
    fileBlock.open = true;
    page.document
      .getElementById('chat-status')!
      .dispatchEvent(new page.window.Event('pointerdown', { bubbles: true }));
    expect(menu.open).toBe(false);
    expect(fileBlock.open).toBe(true);
  });

  it('closes on Escape and hands focus back to its button', () => {
    const { page, menu } = openMenu();
    const box = element(page, 'auto-expand-files');
    box.focus();
    box.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.open).toBe(false);
    expect(page.document.activeElement).toBe(menu.querySelector('summary'));
  });
});

describe('recent messages', () => {
  function recentFlags(page: { document: Document }) {
    return [...page.document.querySelectorAll('.message')].map(message =>
      message.classList.contains('recent')
    );
  }

  it('marks what came after the last human message', () => {
    const messages = [
      chatMessage('m1', 'ai'),
      chatMessage('m2', 'human'),
      chatMessage('m3', 'ai'),
      chatMessage('m4', 'ai'),
    ];
    const page = openPage(chatHtml({ messages }), { url: CHAT_URL });
    expect(recentFlags(page)).toEqual([false, false, true, true]);
  });

  it('marks everything before the first answer', () => {
    const messages = [chatMessage('m1', 'ai'), chatMessage('m2', 'ai')];
    const page = openPage(chatHtml({ messages }), { url: CHAT_URL });
    expect(recentFlags(page)).toEqual([true, true]);
  });

  it('moves the marks as messages arrive', async () => {
    const page = openPage(chatHtml({ messages: [chatMessage('m1', 'ai')] }), { url: CHAT_URL });
    expect(recentFlags(page)).toEqual([true]);

    // Answered from another tab.
    await page.poll({
      ...chatUpdate(null),
      html: messagesFragment([chatMessage('m2', 'human')]),
      count: 2,
    });
    expect(recentFlags(page)).toEqual([false, false]);

    await page.poll({
      ...chatUpdate('r2'),
      html: messagesFragment([chatMessage('m3', 'ai')]),
      count: 3,
    });
    expect(recentFlags(page)).toEqual([false, false, true]);
  });
});
