import { Router } from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import * as db from './db.js';
import { createWebToken, WEB_COOKIE_NAME } from './middleware.js';
import { notifyResponse } from './pollManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const webRouter = Router();

// GET /login - Login page
webRouter.get('/login', (_req, res) => {
  res.send(loginPageHtml());
});

// POST /login - Validate password
webRouter.post('/login', (req, res) => {
  const { password } = req.body || {};

  if (!config.webPassword || password === config.webPassword) {
    const token = createWebToken();
    res.setHeader(
      'Set-Cookie',
      `${WEB_COOKIE_NAME}=${token}; Path=/web; HttpOnly; SameSite=Strict; Max-Age=86400`
    );
    res.redirect('/web/');
    return;
  }

  res.send(loginPageHtml('Wrong password'));
});

// GET / - Session list page
webRouter.get('/', (_req, res) => {
  const sessions = db.listSessions();
  const sessionsWithPending = sessions.map(s => ({
    ...s,
    hasPending: !!db.getPendingRequestForSession(s.id),
  }));
  res.send(sessionListHtml(sessionsWithPending));
});

// GET /sessions/:id - Chat view
webRouter.get('/sessions/:id', (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) {
    res.status(404).send('Session not found');
    return;
  }

  const messages = db.getMessages(session.id);
  const pendingRequest = db.getPendingRequestForSession(session.id);
  res.send(sessionChatHtml(session, messages, pendingRequest));
});

// POST /sessions/:id/respond - Submit human response
webRouter.post('/sessions/:id/respond', (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const pendingRequest = db.getPendingRequestForSession(session.id);
  if (!pendingRequest) {
    res.status(409).json({ error: 'No pending request' });
    return;
  }

  const { content } = req.body || {};
  if (!content || typeof content !== 'string') {
    res.status(400).json({ error: 'content is required' });
    return;
  }

  const messageId = crypto.randomBytes(16).toString('hex');
  db.addMessage(messageId, session.id, 'human', content, null);
  db.answerRequest(pendingRequest.id, messageId);

  // Wake up any long-polling API caller
  notifyResponse(pendingRequest.id, content);

  res.redirect(`/web/sessions/${session.id}`);
});

// ── JSON APIs for client-side polling ──

// GET /api/sessions - List sessions
webRouter.get('/api/sessions', (_req, res) => {
  const sessions = db.listSessions();
  const withPending = sessions.map(s => ({
    ...s,
    hasPending: !!db.getPendingRequestForSession(s.id),
  }));
  res.json(withPending);
});

// GET /api/sessions/:id/messages - Get messages
webRouter.get('/api/sessions/:id/messages', (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(db.getMessages(session.id));
});

// GET /api/sessions/:id/pending - Check pending status
webRouter.get('/api/sessions/:id/pending', (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const pending = db.getPendingRequestForSession(session.id);
  res.json({ hasPending: !!pending, requestId: pending?.id ?? null });
});

// ── HTML Templates ──

function loginPageHtml(errorMsg?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Touch Grass - Login</title>
  <link rel="stylesheet" href="/web/static/style.css">
</head>
<body>
  <div class="login-container">
    <h1>Touch Grass</h1>
    <p class="subtitle">Remote Human Minion Interface</p>
    ${errorMsg ? `<p class="error">${escapeHtml(errorMsg)}</p>` : ''}
    <form method="POST" action="/web/login">
      <input type="password" name="password" placeholder="Password" autofocus required>
      <button type="submit">Enter</button>
    </form>
  </div>
</body>
</html>`;
}

interface SessionWithPending {
  id: string;
  displayName: string | null;
  createdAt: string;
  lastActivityAt: string;
  hasPending: boolean;
}

function sessionListHtml(sessions: SessionWithPending[]): string {
  const sessionRows = sessions
    .map(
      s => `
    <a href="/web/sessions/${escapeHtml(s.id)}" class="session-card ${s.hasPending ? 'pending' : ''}">
      <div class="session-header">
        <span class="session-name">${escapeHtml(s.displayName || s.id.slice(0, 12))}</span>
        ${s.hasPending ? '<span class="badge">needs response</span>' : ''}
      </div>
      <div class="session-meta">
        Last activity: ${new Date(s.lastActivityAt).toLocaleString()}
      </div>
    </a>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Touch Grass - Sessions</title>
  <link rel="stylesheet" href="/web/static/style.css">
</head>
<body>
  <div class="container">
    <h1>Touch Grass</h1>
    <p class="subtitle">Active Sessions</p>
    <div class="session-list" id="session-list">
      ${sessions.length > 0 ? sessionRows : '<p class="empty">No sessions yet. Waiting for an AI to call...</p>'}
    </div>
  </div>
  <script>
    setInterval(async () => {
      try {
        const res = await fetch('/web/api/sessions');
        if (res.ok) location.reload();
      } catch {}
    }, 5000);
  </script>
</body>
</html>`;
}

import type { Session, SessionMessage, PendingRequest } from './types.js';

function sessionChatHtml(
  session: Session,
  messages: SessionMessage[],
  pendingRequest: PendingRequest | undefined
): string {
  const messageBlocks = messages
    .map(m => {
      let filesHtml = '';
      if (m.files) {
        try {
          const files = JSON.parse(m.files) as Array<{ path: string; content: string }>;
          filesHtml = files
            .map(
              f => `
            <details class="file-block">
              <summary>${escapeHtml(f.path)}</summary>
              <pre><code>${escapeHtml(f.content)}</code></pre>
            </details>`
            )
            .join('');
        } catch {
          // ignore malformed files JSON
        }
      }

      return `
      <div class="message ${m.role}">
        <div class="message-role">${m.role === 'ai' ? 'AI' : 'Human'}</div>
        <div class="message-content">${escapeHtml(m.content)}</div>
        ${filesHtml}
        <div class="message-time">${new Date(m.createdAt).toLocaleString()}</div>
      </div>`;
    })
    .join('\n');

  const inputDisabled = !pendingRequest;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Touch Grass - ${escapeHtml(session.displayName || session.id.slice(0, 12))}</title>
  <link rel="stylesheet" href="/web/static/style.css">
</head>
<body>
  <div class="container chat-container">
    <div class="chat-header">
      <a href="/web/" class="back-link">&larr; Sessions</a>
      <h2>${escapeHtml(session.displayName || 'Session ' + session.id.slice(0, 12))}</h2>
    </div>
    <div class="messages" id="messages">
      ${messageBlocks}
    </div>
    <form method="POST" action="/web/sessions/${escapeHtml(session.id)}/respond" class="respond-form" id="respond-form">
      <textarea name="content" placeholder="${inputDisabled ? 'Waiting for AI to send a message...' : 'Type your response...'}" ${inputDisabled ? 'disabled' : ''} id="response-input" rows="3"></textarea>
      <button type="submit" ${inputDisabled ? 'disabled' : ''} id="send-btn">Send</button>
    </form>
  </div>
  <script>
    const sessionId = '${session.id}';
    const messagesEl = document.getElementById('messages');
    const input = document.getElementById('response-input');
    const sendBtn = document.getElementById('send-btn');
    let lastMessageCount = ${messages.length};

    // Auto-scroll to bottom
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Poll for new messages and pending status
    setInterval(async () => {
      try {
        const [msgsRes, pendingRes] = await Promise.all([
          fetch('/web/api/sessions/' + sessionId + '/messages'),
          fetch('/web/api/sessions/' + sessionId + '/pending')
        ]);
        if (!msgsRes.ok || !pendingRes.ok) return;

        const msgs = await msgsRes.json();
        const { hasPending } = await pendingRes.json();

        // Reload if message count changed
        if (msgs.length !== lastMessageCount) {
          location.reload();
          return;
        }

        // Update input state based on pending status
        input.disabled = !hasPending;
        sendBtn.disabled = !hasPending;
        input.placeholder = hasPending ? 'Type your response...' : 'Waiting for AI to send a message...';
      } catch {}
    }, 3000);
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
