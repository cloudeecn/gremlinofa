import { Router } from 'express';
import crypto from 'crypto';
import { config } from './config.js';
import * as db from './db.js';
import { waitForResponse } from './pollManager.js';

export const apiRouter = Router();

function genId(): string {
  return crypto.randomBytes(16).toString('hex');
}

// POST /sessions - Create a new session
apiRouter.post('/sessions', (req, res) => {
  const callerId = req.callerId!;
  const { displayName } = req.body || {};

  const session = db.createSession(genId(), callerId, displayName ?? null);
  res.status(201).json({ sessionId: session.id });
});

// GET /sessions/:id - Get session with messages
apiRouter.get('/sessions/:id', (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const messages = db.getMessages(session.id);
  const pendingRequest = db.getPendingRequestForSession(session.id);

  res.json({
    session,
    messages,
    hasPendingRequest: !!pendingRequest,
  });
});

// DELETE /sessions/:id - Delete session
apiRouter.delete('/sessions/:id', (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  db.deleteSession(session.id);
  res.json({ deleted: true });
});

// POST /sessions/:id/message - Send AI message and create pending request
apiRouter.post('/sessions/:id/message', (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const { content, files } = req.body || {};
  if (!content || typeof content !== 'string') {
    res.status(400).json({ error: 'content is required and must be a string' });
    return;
  }

  const filesJson = Array.isArray(files) ? JSON.stringify(files) : null;
  const messageId = genId();
  db.addMessage(messageId, session.id, 'ai', content, filesJson);

  const requestId = genId();
  db.createRequest(requestId, session.id, messageId);

  res.status(201).json({ requestId, messageId });
});

// GET /requests/:id/poll - Long-poll for human response
apiRouter.get('/requests/:id/poll', async (req, res) => {
  const request = db.getRequest(req.params.id);
  if (!request) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }

  if (request.status === 'expired') {
    res.json({ status: 'expired' });
    return;
  }

  if (request.status === 'answered' && request.responseMessageId) {
    const messages = db.getMessages(request.sessionId);
    const responseMsg = messages.find(m => m.id === request.responseMessageId);
    res.json({
      status: 'answered',
      response: { content: responseMsg?.content ?? '' },
    });
    return;
  }

  // Long-poll: wait for response or timeout
  const content = await waitForResponse(request.id, config.pollTimeoutMs);

  if (content !== null) {
    res.json({
      status: 'answered',
      response: { content },
    });
  } else {
    // Re-check in case it was answered while we set up the wait
    const refreshed = db.getRequest(req.params.id);
    if (refreshed?.status === 'answered' && refreshed.responseMessageId) {
      const messages = db.getMessages(refreshed.sessionId);
      const responseMsg = messages.find(m => m.id === refreshed.responseMessageId);
      res.json({
        status: 'answered',
        response: { content: responseMsg?.content ?? '' },
      });
    } else if (refreshed?.status === 'expired') {
      res.json({ status: 'expired' });
    } else {
      res.json({ status: 'pending' });
    }
  }
});
