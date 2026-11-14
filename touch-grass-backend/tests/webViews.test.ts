import { describe, expect, it } from 'vitest';
import type {
  InjectedFile,
  RequestRecord,
  Session,
  SessionListEntry,
  SessionMessage,
  User,
  UserStats,
} from '../src/types.js';
import type { WebPrincipal } from '../src/webAuth.js';
import {
  accountPage,
  adminPage,
  chatPage,
  chatState,
  chatStatusHtml,
  escapeHtml,
  loginPage,
  messagesFragment,
  renderMarkdown,
  sessionListFragment,
  sessionListPage,
  stripLineNumbers,
  undeliveredAnswerHtml,
  webRootFor,
} from '../src/webViews.js';

const ADMIN: WebPrincipal = { role: 'admin', username: 'Admin' };
const BOB: WebPrincipal = {
  role: 'user',
  id: 'b'.repeat(32),
  username: 'bob',
  token: 'tg_bob-token',
};

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
    userToken: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    lastActivityAt: '2026-10-08T10:00:00.000Z',
  };
  const listPage = sessionListPage({
    base: './',
    listHtml: '',
    pendingIds: [],
    signature: 's',
    viewer: ADMIN,
  });
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

describe('login page', () => {
  it('asks for a username the browser fills, and focuses it', () => {
    const html = loginPage({ base: './', returnTo: '' });
    expect(html).toMatch(
      /<input id="username" type="text" name="username" placeholder="Username" value=""\s+autocomplete="username" autocapitalize="none" spellcheck="false" autofocus required>/
    );
    expect(html).toMatch(/<label for="username" class="visually-hidden">Username<\/label>/);
    expect(html).toMatch(/autocomplete="current-password" required>/);
  });

  it('keeps a refused username, escaped, and moves the focus to the password', () => {
    const html = loginPage({ base: './', returnTo: 'admin', username: '"><b>bob' });
    expect(html).toContain('value="&quot;&gt;&lt;b&gt;bob"');
    expect(html).not.toContain('<b>bob');
    expect(html).toMatch(/autocomplete="current-password" autofocus required>/);
    expect(html).toContain('name="next" value="admin"');
  });
});

describe('session owners', () => {
  function entry(overrides: Partial<SessionListEntry>): SessionListEntry {
    return {
      id: 'sess1',
      callerId: 'caller',
      displayName: 'Deploy check',
      userToken: null,
      createdAt: '2026-10-08T10:00:00.000Z',
      lastActivityAt: '2026-10-08T10:00:00.000Z',
      pending: null,
      ownerUsername: null,
      ...overrides,
    };
  }

  const sessions = [
    entry({ id: 's1', userToken: 'tg_x', ownerUsername: '<bob>' }),
    entry({ id: 's2' }),
  ];

  it('labels each session with its owner when asked', () => {
    const html = sessionListFragment(sessions, './', { showOwner: true });
    expect(html).toContain('caller: caller &middot; user: &lt;bob&gt;</span>');
    expect(html).toContain('caller: caller &middot; no token</span>');
  });

  it('says nothing about owners by default', () => {
    const html = sessionListFragment(sessions, './');
    expect(html).not.toContain('user:');
    expect(html).not.toContain('no token');
    expect(html).not.toContain('tg_x');
  });

  it('names the owner on the chat page only when given one', () => {
    const session: Session = {
      id: 'sess1',
      callerId: 'caller',
      displayName: null,
      userToken: 'tg_x',
      createdAt: '2026-10-08T10:00:00.000Z',
      lastActivityAt: '2026-10-08T10:00:00.000Z',
    };
    const chat = (owner?: string | null) =>
      chatPage({
        base: '../',
        session,
        messages: [],
        state: chatState(undefined, undefined),
        othersPending: [],
        ...(owner !== undefined && { owner }),
      });
    expect(chat('bob')).toContain('caller: caller &middot; user: bob</span>');
    expect(chat(null)).toContain('caller: caller &middot; no token</span>');
    expect(chat()).toContain('caller: caller</span>');
    expect(chat()).not.toContain('tg_x');
  });
});

describe('session list toolbar', () => {
  const pageFor = (viewer: WebPrincipal) =>
    sessionListPage({ base: './', listHtml: '', pendingIds: [], signature: 's', viewer });

  it('shows who is signed in, with Account, Users and Log out for the admin', () => {
    const html = pageFor(ADMIN);
    expect(html).toContain('Signed in as <strong>Admin</strong>');
    expect(html).toContain('<a href="./account" class="toolbar-link">Account</a>');
    expect(html).toContain('<a href="./admin" class="toolbar-link">Users</a>');
    expect(html).toContain('action="./logout"');
  });

  it('leaves Users out for a user and escapes the name', () => {
    const html = pageFor({ ...BOB, username: '<bob>' });
    expect(html).toContain('Signed in as <strong>&lt;bob&gt;</strong>');
    expect(html).toContain('href="./account"');
    expect(html).not.toContain('href="./admin"');
    expect(html).not.toContain('tg_bob-token');
  });
});

describe('accountPage', () => {
  it("shows a user's token, selectable in one click, and the change-password form", () => {
    const html = accountPage({ base: './', viewer: BOB });
    expect(html).toContain('data-page="account"');
    expect(html).toContain('Signed in as <strong>bob</strong>');
    expect(html).toContain('<code class="token">tg_bob-token</code>');
    expect(html).toContain('<code>remoteToken</code>');
    expect(html).toContain('<form method="post" action="./account" class="stacked-form">');
    expect(html).toMatch(/name="current" autocomplete="current-password"/);
    expect(html.match(/autocomplete="new-password"/g)).toHaveLength(2);
    expect(html).toContain('name="confirm"');
    expect(html).not.toContain('href="./admin"');
  });

  it('tells the admin the password lives in .env, with no form', () => {
    const html = accountPage({ base: './', viewer: ADMIN });
    expect(html).toContain('Signed in as <strong>Admin</strong> (admin)');
    expect(html).toContain('<code>WEB_PASSWORD</code>');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('class="token"');
    expect(html).toContain('href="./admin"');
  });

  it('shows a banner and keeps every URL relative', () => {
    const html = accountPage({
      base: '../',
      viewer: BOB,
      banner: { kind: 'error', html: 'Your current password is wrong.' },
    });
    expect(html).toContain('class="banner banner-error"');
    expect(html).toContain('action="../account"');
    expect(html).toContain('href="../static/style.css"');
  });
});

describe('adminPage', () => {
  const stats = (overrides: Partial<UserStats> = {}): UserStats => ({
    sessions: 0,
    aiMessages: 0,
    humanReplies: 0,
    pending: 0,
    lastActivityAt: null,
    ...overrides,
  });
  const user = (id: string, username: string): User => ({
    id,
    username,
    passwordHash: 'scrypt$secret-hash',
    token: `tg_${username}-token`,
    createdAt: '2026-10-08T09:00:00.000Z',
  });
  const bob = user('b'.repeat(32), 'bob');
  const sneaky = user('c'.repeat(32), '<img>');
  const report = {
    users: [
      {
        user: bob,
        stats: stats({
          sessions: 3,
          aiMessages: 7,
          humanReplies: 5,
          pending: 1,
          lastActivityAt: '2026-10-08T11:00:00.000Z',
        }),
      },
      { user: sneaky, stats: stats() },
    ],
    noToken: stats({ sessions: 2, aiMessages: 4 }),
  };

  it('lists each user with live counts, then the no-token row', () => {
    const html = adminPage({ base: './', report });
    expect(html).toContain('data-page="admin"');
    expect(html).toMatch(
      /<th scope="row">bob<\/th>\s*<td class="num">3<\/td><td class="num">7<\/td><td class="num">5<\/td><td class="num">1<\/td><td><time datetime="2026-10-08T11:00:00.000Z">/
    );
    expect(html).toMatch(
      /<th scope="row">No token \(admin only\)<\/th>\s*<td class="num">2<\/td><td class="num">4<\/td><td class="num">0<\/td><td class="num">0<\/td><td>&mdash;<\/td>/
    );
    expect(html.indexOf('>bob<')).toBeLessThan(html.indexOf('No token (admin only)'));
    expect(html).toContain('Counts cover the sessions still on the server');
  });

  it('gives each user a closed panel with the token and forms, never the hash', () => {
    const html = adminPage({ base: './', report });
    expect(html).toContain('<details class="user-manage">');
    expect(html).not.toContain('<details class="user-manage" open>');
    expect(html).toContain('<code class="token">tg_bob-token</code>');
    expect(html).toContain(`action="./admin/users/${bob.id}/rename"`);
    expect(html).toContain(`action="./admin/users/${bob.id}/password"`);
    expect(html).toContain(`action="./admin/users/${bob.id}/delete"`);
    expect(html).toContain(
      'data-confirm="Delete user &quot;bob&quot;? Their sessions stay and become admin-only."'
    );
    expect(html).not.toContain('secret-hash');
  });

  it('escapes usernames everywhere they appear', () => {
    const html = adminPage({ base: './', report });
    expect(html).not.toContain('<img>');
    expect(html).toContain('<th scope="row">&lt;img&gt;</th>');
    expect(html).toContain('value="&lt;img&gt;"');
    expect(html).toContain('Delete user &quot;&lt;img&gt;&quot;?');
  });

  it("keeps the browser's saved login out of the new-user and reset fields", () => {
    const html = adminPage({ base: './', report });
    expect(html).toMatch(
      /<input id="new-username" type="text" name="username" value=""\s+autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="64" required>/
    );
    expect(html).toMatch(
      /id="new-password" type="password" name="password" autocomplete="new-password"/
    );
    expect(html).toMatch(
      new RegExp(`id="reset-${bob.id}" type="password" name="password" autocomplete="new-password"`)
    );
    expect(html).toMatch(new RegExp(`id="rename-${bob.id}" [^>]*autocomplete="off"`));
    expect(html).not.toContain('current-password');
  });

  it('shows a new user and its token in a banner', () => {
    const html = adminPage({ base: '../', report, created: bob });
    expect(html).toContain(
      'Added <strong>bob</strong>. Their token is <code class="token">tg_bob-token</code>.'
    );
    expect(html).toContain('action="../admin/users"');
  });

  it("re-renders a refused form with what was typed and that user's panel open", () => {
    const html = adminPage({
      base: '../../../',
      report,
      banner: { kind: 'error', html: 'taken' },
      form: { newUsername: '"carol', userId: bob.id, rename: 'Robert"' },
    });
    expect(html).toContain('id="new-username" type="text" name="username" value="&quot;carol"');
    expect(html).toContain('<details class="user-manage" open>');
    expect(html).toContain('value="Robert&quot;"');
    expect(html.match(/<details class="user-manage" open>/g)).toHaveLength(1);
    expect(html).toContain('src="../../../static/app.js"');
  });

  it('says so when there are no users yet', () => {
    const html = adminPage({ base: './', report: { users: [], noToken: stats() } });
    expect(html).toContain('No users yet');
    expect(html).toContain('No token (admin only)');
  });
});
