import { describe, expect, it } from 'vitest';
import type { InjectedFile, RequestRecord, Session, SessionMessage } from '../src/types.js';
import {
  chatPage,
  chatState,
  chatStatusHtml,
  escapeHtml,
  messagesFragment,
  renderMarkdown,
  sessionListPage,
  stripLineNumbers,
  undeliveredAnswerHtml,
  webRootFor,
} from '../src/webViews.js';

function request(overrides: Partial<RequestRecord>): RequestRecord {
  return {
    id: 'req1',
    sessionId: 'sess1',
    messageId: 'msg1',
    status: 'pending',
    responseMessageId: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    answeredAt: null,
    expiresAt: null,
    expireReason: null,
    expiredAt: null,
    ...overrides,
  };
}

function message(overrides: Partial<SessionMessage>): SessionMessage {
  return {
    id: 'm1',
    sessionId: 's',
    role: 'ai',
    content: 'TEXT',
    files: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    awaitsReply: true,
    ...overrides,
  };
}

/** The markup of a message carrying one file. */
function fileHtml(file: Omit<InjectedFile, 'placement'>): string {
  return messagesFragment([message({ files: [{ placement: 'before', ...file }] })]);
}

describe('webRootFor', () => {
  it.each([
    ['/', './'],
    ['/login', './'],
    ['/sessions/abc', '../'],
    ['/sessions/abc/', '../../'],
    ['/sessions/abc/respond', '../../'],
    ['/api/sessions/abc/updates', '../../../'],
  ])('%s → %s', (routerPath, expected) => {
    expect(webRootFor(routerPath)).toBe(expected);
  });

  it('resolves back to the web root from every depth, under any prefix', () => {
    for (const routerPath of ['/', '/login', '/sessions/abc', '/sessions/abc/respond']) {
      const pageUrl = `https://proxy.example/some/prefix/web${routerPath}`;
      expect(new URL(webRootFor(routerPath), pageUrl).pathname).toBe('/some/prefix/web/');
    }
  });
});

describe('escapeHtml', () => {
  it('escapes markup and both quote styles', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;&lt;/a&gt;'
    );
  });
});

describe('messagesFragment', () => {
  it('puts before-files above the text, after-files below, and skips empty text', () => {
    const html = messagesFragment([
      message({
        files: [
          { path: 'late.md', content: 'L', placement: 'after' },
          { path: 'early.md', content: 'E\nE', placement: 'before' },
        ],
      }),
      message({
        id: 'm2',
        role: 'human',
        content: '',
        createdAt: '2026-10-08T10:01:00.000Z',
        awaitsReply: false,
      }),
    ]);
    expect(html.indexOf('early.md')).toBeLessThan(html.indexOf('TEXT'));
    expect(html.indexOf('TEXT')).toBeLessThan(html.indexOf('late.md'));
    expect(html).toContain('2 lines');
    expect(html.match(/message-content/g)).toHaveLength(1);
    expect(html).toContain('<time datetime="2026-10-08T10:01:00.000Z">2026-10-08 10:01 UTC</time>');
  });

  it('tags an async AI note, but not a question or a human answer', () => {
    expect(messagesFragment([message({ awaitsReply: false })])).toContain('no reply needed');
    expect(messagesFragment([message({})])).not.toContain('no reply needed');
    expect(messagesFragment([message({ role: 'human', awaitsReply: false })])).not.toContain(
      'no reply needed'
    );
  });
});

describe('message bodies', () => {
  it('opens an AI message rendered, with the raw text and a pressed toggle', () => {
    const html = messagesFragment([message({ content: '# Plan\n\n- **one**' })]);
    expect(html).toContain('<article class="message ai" data-views>');
    expect(html).toContain('<div class="message-content" data-view="raw" hidden># Plan');
    expect(html).toContain(
      '<div class="message-markdown markdown" data-view="rendered"><h1>Plan</h1>'
    );
    expect(html).toContain('<strong>one</strong>');
    expect(html).toMatch(/<button [^>]*class="secondary-button view-toggle" aria-pressed="true">/);
  });

  it('keeps raw HTML in a message as text in both views', () => {
    const html = messagesFragment([message({ content: 'hi <img src=x onerror=alert(1)>' })]);
    expect(html).not.toContain('<img');
    expect(html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g)).toHaveLength(2);
  });

  it('shows human answers as typed, with no toggle', () => {
    const html = messagesFragment([message({ role: 'human', content: '# not a heading' })]);
    expect(html).toContain('<div class="message-content"># not a heading</div>');
    expect(html).not.toContain('view-toggle');
    expect(html).not.toContain('data-views');
  });

  it.each([
    ['whitespace', '   \n  '],
    ['oversized', 'x'.repeat(200_001)],
  ])('gives a %s AI message the raw view only', (_kind, content) => {
    const html = messagesFragment([message({ content })]);
    expect(html).toContain('<div class="message-content">');
    expect(html).not.toContain('view-toggle');
    expect(html).not.toContain('message-markdown');
  });
});

describe('file blocks', () => {
  it('opens markdown files rendered, with the raw text hidden', () => {
    const html = fileHtml({ path: 'notes/PLAN.md', content: '# Plan\n\n- one' });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('<pre class="file-raw" data-view="raw" hidden>');
    expect(html).toContain(
      '<div class="file-markdown markdown" data-view="rendered"><h1>Plan</h1>'
    );
    expect(html).toContain('<li>one</li>');
  });

  it('opens other files raw, with the rendered view ready behind the toggle', () => {
    const html = fileHtml({ path: 'src/app.ts', content: 'const a = 1;' });
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('<pre class="file-raw" data-view="raw"><code>const a = 1;</code></pre>');
    expect(html).toContain('<div class="file-markdown markdown" data-view="rendered" hidden>');
  });

  it('strips line numbers from the rendered view only, and only when flagged', () => {
    const content = '     1\t# Title\n     2\t\n     3\tBody';
    const flagged = fileHtml({ path: 'a.md', content, lineNumbers: true });
    expect(flagged).toContain('<h1>Title</h1>');
    expect(flagged).toContain('     1\t# Title');
    expect(fileHtml({ path: 'a.md', content })).not.toContain('<h1>Title</h1>');
  });

  it('has no toggle for an empty or oversized file', () => {
    // The message around the file has a toggle of its own, so look inside the file block only.
    const blockOf = (file: Omit<InjectedFile, 'placement'>) =>
      fileHtml(file).match(/<details class="file-block"[^]*?<\/details>/)![0];
    expect(blockOf({ path: 'empty.md', content: '' })).not.toContain('view-toggle');
    expect(blockOf({ path: 'big.md', content: 'x'.repeat(200_001) })).not.toContain('view-toggle');
  });
});

describe('renderMarkdown', () => {
  it('shows raw HTML as text, block and inline', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('keeps web and mail links, and drops other schemes to their text', () => {
    expect(renderMarkdown('[docs](https://example.com/a?b="c")')).toContain(
      '<a href="https://example.com/a?b=&quot;c&quot;" rel="noopener noreferrer" target="_blank">docs</a>'
    );
    expect(renderMarkdown('[mail](mailto:a@example.com)')).toContain('href="mailto:a@example.com"');
    const scripted = renderMarkdown('[click](javascript:alert(1))');
    expect(scripted).not.toContain('<a');
    expect(scripted).toContain('click');
  });

  it('turns images into links', () => {
    const html = renderMarkdown('![chart](https://example.com/c.png) ![x](javascript:alert(1))');
    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://example.com/c.png"');
    expect(html).toContain('[image: chart]');
    expect(html).toContain('[image: x]');
    expect(html).not.toContain('javascript:');
  });

  it('renders GFM tables', () => {
    expect(renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |')).toContain('<td>1</td>');
  });
});

describe('stripLineNumbers', () => {
  it('removes the minion tool prefix and leaves other lines alone', () => {
    expect(stripLineNumbers('Preamble\n     1\tfirst\n1234567\tbig\n  not\tnumbered')).toBe(
      'Preamble\nfirst\nbig\n  not\tnumbered'
    );
  });
});

describe('chatState', () => {
  it('reports a pending request with its deadline', () => {
    const state = chatState(request({ expiresAt: '2026-10-08T10:10:00.000Z' }), undefined);
    expect(state.pending).toEqual({ requestId: 'req1', expiresAt: '2026-10-08T10:10:00.000Z' });
    expect(state.stoppedWaiting).toBeNull();
    expect(chatStatusHtml(state)).toContain('data-countdown');
  });

  it.each(['timeout', 'cancelled'] as const)('reports a %s as stoppedWaiting', reason => {
    const state = chatState(
      request({ status: 'expired', expireReason: reason, expiredAt: '2026-10-08T10:05:00.000Z' }),
      undefined
    );
    expect(state.pending).toBeNull();
    expect(state.stoppedWaiting).toEqual({ at: '2026-10-08T10:05:00.000Z', reason });
    expect(chatStatusHtml(state)).toContain('The AI stopped waiting at');
  });

  it('does not count superseded or answered requests as stopped waiting', () => {
    expect(
      chatState(request({ status: 'expired', expireReason: 'superseded' }), undefined)
        .stoppedWaiting
    ).toBeNull();
    const answered = chatState(request({ status: 'answered' }), message({}));
    expect(answered.stoppedWaiting).toBeNull();
    expect(chatStatusHtml(answered)).toContain('Answer delivered');
    expect(chatStatusHtml(chatState(undefined, undefined))).toContain(
      'Waiting for the AI to send a message'
    );
  });

  it('says an async note needs no answer, even after a question timed out', () => {
    const note = message({ id: 'm2', awaitsReply: false });
    const state = chatState(request({ status: 'expired', expireReason: 'timeout' }), note);
    expect(state.note).toBe(true);
    expect(chatStatusHtml(state)).toContain('needs no answer');
    expect(chatState(undefined, message({ role: 'human', awaitsReply: false })).note).toBe(false);
  });
});

describe('undeliveredAnswerHtml', () => {
  it.each([
    ['', undefined, 'no open question'],
    ['gone', undefined, 'no longer exists'],
    ['req1', request({ status: 'answered' }), 'already answered'],
    ['req1', request({ status: 'expired', expireReason: 'superseded' }), 'sent a new message'],
    ['req1', request({ status: 'expired', expireReason: 'timeout' }), 'deadline passed'],
    ['req1', request({ status: 'expired', expireReason: 'cancelled' }), 'cancelled the question'],
  ])('explains requestId %j', (requestId, record, phrase) => {
    const html = undeliveredAnswerHtml(requestId, record);
    expect(html).toContain(phrase);
    expect(html).toContain('Your draft is back in the box below.');
  });
});

describe('page chrome', () => {
  const session: Session = {
    id: 'sess1',
    callerId: 'caller',
    displayName: 'Deploy check',
    createdAt: '2026-10-08T10:00:00.000Z',
    lastActivityAt: '2026-10-08T10:00:00.000Z',
  };
  const listPage = sessionListPage({ base: './', listHtml: '', pendingIds: [], signature: 's' });
  const chat = chatPage({
    base: '../',
    session,
    messages: [],
    state: chatState(undefined, undefined),
    othersPending: [],
  });

  it('offers Log out on the session list only', () => {
    expect(listPage).toContain('action="./logout"');
    expect(chat).not.toContain('logout');
  });

  it('has the sound switch on both pages, starting off and hidden until app.js wires it', () => {
    for (const html of [listPage, chat]) {
      expect(html).toMatch(/<button [^>]*id="sound-toggle"[^>]*data-state="off" hidden>/);
      expect(html).toContain('<span class="sound-label">Sound off</span>');
      expect(html).not.toContain('sound-hint');
    }
  });

  it('gives the chat page a bare back arrow that still names itself', () => {
    const backButton = chat.match(/<a [^>]*class="back-button"[^>]*>(.*?)<\/a>/s)?.[1];
    expect(backButton).toBeDefined();
    expect(backButton!.replace(/<span class="visually-hidden">.*?<\/span>/, '')).not.toContain(
      'Sessions'
    );
    expect(backButton).toContain('<span class="visually-hidden">Back to sessions</span>');
  });

  it('counts the characters of a draft the server puts back, an emoji as one', () => {
    const withDraft = (draft: string) =>
      chatPage({
        base: '../',
        session,
        messages: [],
        state: chatState(undefined, undefined),
        othersPending: [],
        draft,
      });
    expect(chat).toContain('<p class="char-count" id="char-count">0 characters</p>');
    expect(withDraft('ok 👍')).toContain('>4 characters</p>');
    expect(withDraft('a')).toContain('>1 character</p>');
  });

  it('puts the auto-expand switch in the chat menu', () => {
    expect(chat).toContain('<details class="menu" id="chat-menu">');
    expect(chat).toContain('<input type="checkbox" id="auto-expand-files">');
    expect(listPage).not.toContain('chat-menu');
  });
});
