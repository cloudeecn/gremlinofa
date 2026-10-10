// Touch Grass web UI. Every page loads this; it reads its state from data-* attributes on
// <body> and builds every URL from data-base, so it works under any reverse-proxy prefix.
// The CSP forbids inline script, so all behavior lives here.
(function () {
  'use strict';

  const body = document.body;
  const base = body.dataset.base || './';
  const LIST_POLL_MS = 5000;
  const CHAT_POLL_MS = 3000;
  const MAX_RETRY_DELAY_MS = 60000;
  const SOUND_KEY = 'tg:sound';
  const NOTIFY_KEY = 'tg:notify';
  const AUTO_EXPAND_KEY = 'tg:auto-expand';
  /** Returned by a poll task to end polling (navigating away, session deleted). */
  const STOP = 'stop';

  // ── Storage: private windows and locked-down browsers throw on access ──

  function storageGet(area, key) {
    try {
      return window[area].getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(area, key, value) {
    try {
      window[area].setItem(key, value);
    } catch {
      // Preferences and drafts are conveniences; the page works without them.
    }
  }

  function storageRemove(area, key) {
    try {
      window[area].removeItem(key);
    } catch {
      // See storageSet.
    }
  }

  // ── Times: the server sends ISO timestamps; show them in the viewer's locale and zone ──

  const shortDateTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const fullDateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (days > 0) return days + 'd ' + hours + 'h';
    if (hours > 0) return hours + 'h ' + minutes + 'm';
    if (minutes > 0) return minutes + 'm ' + seconds + 's';
    return seconds + 's';
  }

  function parseTime(el) {
    const date = new Date(el.getAttribute('datetime'));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function renderTime(el, nowMs) {
    const date = parseTime(el);
    if (!date) return;
    if (el.hasAttribute('data-elapsed')) {
      el.textContent = formatDuration(nowMs - date.getTime());
    } else if (el.hasAttribute('data-countdown')) {
      const leftMs = date.getTime() - nowMs;
      el.textContent =
        shortDateTime.format(date) +
        (leftMs > 0 ? ' (' + formatDuration(leftMs) + ' left)' : ' (time is up)');
    } else {
      el.textContent = shortDateTime.format(date);
    }
  }

  function formatTimes(root) {
    const nowMs = Date.now();
    root.querySelectorAll('time[datetime]').forEach(function (el) {
      renderTime(el, nowMs);
      const date = parseTime(el);
      if (date) el.title = fullDateTime.format(date);
    });
  }

  function tickLiveTimes() {
    const nowMs = Date.now();
    document.querySelectorAll('time[data-elapsed], time[data-countdown]').forEach(function (el) {
      renderTime(el, nowMs);
    });
  }

  // ── Banners ──

  function showBanner(el, kind, text) {
    if (!el) return;
    el.className = 'banner banner-' + kind;
    el.querySelector('.banner-text').textContent = text;
    el.hidden = false;
  }

  function hideBanner(el) {
    if (el) el.hidden = true;
  }

  document.addEventListener('click', function (event) {
    const closeButton = event.target.closest && event.target.closest('.banner-close');
    if (closeButton) closeButton.closest('.banner').hidden = true;
  });

  // AI messages and injected files switch between raw text and rendered markdown. The nearest
  // data-views element holds both views, so a file's toggle never flips the message around it.
  // Delegated, since chat updates append messages.
  document.addEventListener('click', function (event) {
    const toggle = event.target.closest && event.target.closest('.view-toggle');
    if (!toggle) return;
    const owner = toggle.closest('[data-views]');
    const raw = owner && owner.querySelector(':scope > [data-view="raw"]');
    const rendered = owner && owner.querySelector(':scope > [data-view="rendered"]');
    if (!raw || !rendered) return;
    const showRendered = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', String(showRendered));
    raw.hidden = showRendered;
    rendered.hidden = !showRendered;
  });

  // Menus close on a press outside them, or on Escape. pointerdown, not click: iOS Safari fires
  // no click for a tap on plain text, so a document-level click listener would miss most taps.
  document.addEventListener('pointerdown', function (event) {
    document.querySelectorAll('details.menu[open]').forEach(function (menu) {
      if (!menu.contains(event.target)) menu.open = false;
    });
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('details.menu[open]').forEach(function (menu) {
      const hadFocus = menu.contains(document.activeElement);
      menu.open = false;
      if (hadFocus) menu.querySelector('summary').focus();
    });
  });

  // Delete buttons on the session list ask first. Delegated, since the list is re-rendered.
  document.addEventListener('submit', function (event) {
    const form = event.target;
    const question = form.getAttribute && form.getAttribute('data-confirm');
    if (question && !window.confirm(question)) event.preventDefault();
  });

  // ── Getting the human's attention: title, favicon, sound, notification ──

  const quietTitle = document.title.replace(/^\(\d+\) /, '');
  const faviconLink = document.querySelector('link[rel="icon"]');
  const quietFavicon = faviconLink ? faviconLink.getAttribute('href') : null;
  const ALERT_FAVICON =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
        '<rect width="32" height="32" rx="7" fill="#16213e"/>' +
        '<path d="M7 27c1-6 0-11-2-16 4 4 6 9 6 16zm6 0c0-9 1-15 3-22 2 7 2 14 2 22zm7 0c1-7 3-11 7-15-2 6-3 10-3 15z" fill="#5fbf6a"/>' +
        '<circle cx="25" cy="7" r="6" fill="#ff5252" stroke="#16213e" stroke-width="2"/>' +
        '</svg>'
    );

  let attentionCount = null;

  function setAttention(count) {
    // Setting a favicon href makes the browser process the link again, so only on a change.
    if (count === attentionCount) return;
    attentionCount = count;
    document.title = count > 0 ? '(' + count + ') ' + quietTitle : quietTitle;
    if (faviconLink && quietFavicon) {
      faviconLink.setAttribute('href', count > 0 ? ALERT_FAVICON : quietFavicon);
    }
  }

  /**
   * If the browser only lets audio play this long after the question arrived, skip the beep:
   * by then it would point at nothing.
   */
  const LATE_BEEP_MS = 2000;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  /**
   * Firefox and Safari start a new context suspended and switch it to running a moment later,
   * even where audio is allowed. Until this much time has passed, a suspended new context counts
   * as starting, not blocked.
   */
  const AUDIO_START_GRACE_MS = 1000;
  let audioContext = null;
  let audioStarting = false;
  /** No Web Audio API, or a context that failed to start: the sound switch could never beep. */
  let audioUnavailable = !AudioContextCtor;

  function soundEnabled() {
    return storageGet('localStorage', SOUND_KEY) === 'on';
  }

  /**
   * 'off', 'on', or 'blocked': sound is on, but the browser holds audio until the page sees a
   * click or key press (suspended, or iOS's interrupted).
   */
  function soundState() {
    if (!soundEnabled()) return 'off';
    if (!audioContext || audioContext.state === 'running' || audioStarting) return 'on';
    return 'blocked';
  }

  const SOUND_SWITCH = {
    on: { label: 'Sound on', title: 'Beeps when a question arrives. Click to turn off.' },
    off: { label: 'Sound off', title: 'Click to beep when a question arrives.' },
    blocked: {
      label: 'Click to enable sound',
      title:
        'Your browser holds audio until you click or press a key on this page. ' +
        'Click here or anywhere.',
    },
  };

  function renderSound() {
    const button = document.getElementById('sound-toggle');
    if (!button) return;
    button.hidden = audioUnavailable;
    const state = soundState();
    button.dataset.state = state;
    button.title = SOUND_SWITCH[state].title;
    button.querySelector('.sound-label').textContent = SOUND_SWITCH[state].label;
  }

  function ensureAudioContext() {
    if (audioContext || audioUnavailable) return audioContext;
    try {
      audioContext = new AudioContextCtor();
      audioContext.addEventListener('statechange', renderSound);
      if (audioContext.state !== 'running') {
        audioStarting = true;
        setTimeout(function () {
          audioStarting = false;
          renderSound();
        }, AUDIO_START_GRACE_MS);
      }
    } catch {
      audioContext = null;
      audioUnavailable = true;
      renderSound();
    }
    return audioContext;
  }

  /** Returns a promise that settles once the context may play. */
  function unlockAudio() {
    if (!soundEnabled()) return Promise.resolve();
    const context = ensureAudioContext();
    if (context && context.state !== 'running') {
      return context.resume().catch(function () {});
    }
    return Promise.resolve();
  }

  // Browsers keep audio suspended until the page sees a click, tap or key press; this runs on
  // every one. A mouse press counts at pointerdown, but a touch only at pointerup / touchend
  // (iOS wants touchend), hence all four. The sound switch unlocks from its own click handler
  // instead: unlocking on its press could flip it from blocked to on before the click lands, and
  // that click would then turn sound off.
  function unlockOnGesture(event) {
    const target = event.target;
    if (target && target.closest && target.closest('#sound-toggle')) return;
    unlockAudio();
  }

  ['pointerdown', 'pointerup', 'touchend', 'keydown'].forEach(function (type) {
    document.addEventListener(type, unlockOnGesture);
  });

  function playTone(context) {
    try {
      const start = context.currentTime;
      const tone = context.createOscillator();
      const volume = context.createGain();
      tone.type = 'sine';
      tone.frequency.setValueAtTime(880, start);
      tone.frequency.setValueAtTime(660, start + 0.18);
      volume.gain.setValueAtTime(0.0001, start);
      volume.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
      volume.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
      tone.connect(volume);
      volume.connect(context.destination);
      tone.start(start);
      tone.stop(start + 0.45);
    } catch {
      // No sound is better than a broken page.
    }
  }

  function beep() {
    if (!soundEnabled()) return;
    const context = ensureAudioContext();
    if (!context) return;
    if (context.state === 'running') {
      playTone(context);
      return;
    }
    // resume() settles once the browser allows audio, which can be the human's next click.
    const askedAt = Date.now();
    context.resume().then(
      function () {
        if (context.state === 'running' && Date.now() - askedAt < LATE_BEEP_MS) playTone(context);
      },
      function () {}
    );
  }

  function notificationsSupported() {
    return window.isSecureContext && 'Notification' in window;
  }

  function notificationsOn() {
    return (
      notificationsSupported() &&
      Notification.permission === 'granted' &&
      storageGet('localStorage', NOTIFY_KEY) === 'on'
    );
  }

  function showNotification(text) {
    // Someone looking at the page already sees the title and favicon change.
    if (!notificationsOn() || (document.visibilityState === 'visible' && document.hasFocus())) {
      return;
    }
    try {
      const notification = new Notification('Touch Grass', { body: text, tag: 'touch-grass' });
      notification.onclick = function () {
        window.focus();
        notification.close();
      };
    } catch {
      // Android Chrome only allows notifications from a service worker; skip quietly.
    }
  }

  function alertHuman(text) {
    beep();
    showNotification(text);
  }

  /**
   * Wires the Sound and Notifications switches. With sound on, the audio context is made at load:
   * Chrome lets it run when the human interacted with an earlier page of this site (such as
   * the answer they just sent), so a question arriving before their next click still beeps.
   * Where the browser holds it suspended, the sound switch shows as blocked until a click.
   */
  function setupAlerts() {
    if (soundEnabled()) ensureAudioContext();
    renderSound();

    const soundButton = document.getElementById('sound-toggle');
    if (soundButton) {
      soundButton.addEventListener('click', function () {
        if (soundState() === 'on') {
          storageSet('localStorage', SOUND_KEY, 'off');
          renderSound();
          return;
        }
        // Off or blocked. This click is the gesture that unlocks audio; play a sample so the
        // human hears it.
        storageSet('localStorage', SOUND_KEY, 'on');
        const unlocked = unlockAudio();
        renderSound();
        unlocked.then(function () {
          renderSound();
          beep();
        });
      });
    }

    const notifyButton = document.getElementById('notify-toggle');
    if (notifyButton && notificationsSupported()) {
      const renderNotify = function () {
        const blocked = Notification.permission === 'denied';
        const on = notificationsOn();
        notifyButton.disabled = blocked;
        notifyButton.textContent = blocked
          ? 'Notifications blocked'
          : 'Notifications: ' + (on ? 'on' : 'off');
        notifyButton.title = blocked
          ? 'Allow notifications for this site in the browser settings, then reload.'
          : '';
        notifyButton.setAttribute('aria-pressed', String(on));
      };
      notifyButton.hidden = false;
      renderNotify();
      notifyButton.addEventListener('click', function () {
        if (notificationsOn()) {
          storageSet('localStorage', NOTIFY_KEY, 'off');
          renderNotify();
          return;
        }
        const permission =
          Notification.permission === 'granted' ? 'granted' : Notification.requestPermission();
        Promise.resolve(permission)
          .then(function (result) {
            if (result === 'granted') storageSet('localStorage', NOTIFY_KEY, 'on');
          })
          .catch(function () {})
          .then(renderNotify);
      });
    }
  }

  // ── Polling ──

  /**
   * Resolves to the parsed JSON, null for a 404, or STOP after starting the trip to the login
   * page on a 401 (expired cookie or a changed WEB_PASSWORD). Throws on anything else.
   */
  function fetchJson(url, returnTo) {
    return fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    }).then(function (res) {
      if (res.status === 401) {
        location.assign(base + 'login' + (returnTo ? '?next=' + encodeURIComponent(returnTo) : ''));
        return STOP;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  /** Runs `task` every `intervalMs`, backing off while the server can't be reached. */
  function startPolling(task, intervalMs) {
    const pollBanner = document.getElementById('poll-banner');
    let failures = 0;

    function tick() {
      Promise.resolve()
        .then(task)
        .then(
          function (outcome) {
            failures = 0;
            hideBanner(pollBanner);
            return outcome;
          },
          function () {
            failures += 1;
            showBanner(pollBanner, 'warn', "Can't reach the server. Retrying…");
          }
        )
        .then(function (outcome) {
          if (outcome === STOP) return;
          const delay =
            failures === 0 ? intervalMs : Math.min(intervalMs * 2 ** failures, MAX_RETRY_DELAY_MS);
          setTimeout(tick, delay);
        });
    }

    setTimeout(tick, intervalMs);
  }

  /** A space-separated id list from a data-* attribute. */
  function idList(text) {
    return text ? text.split(' ') : [];
  }

  /**
   * Whether `next` holds an id missing from `known`: a question the human hasn't been alerted
   * to. Counting would miss one question replacing another between two polls.
   */
  function hasNewId(known, next) {
    return next.some(function (id) {
      return known.indexOf(id) === -1;
    });
  }

  // ── Session list ──

  function initSessionList() {
    const list = document.getElementById('session-list');
    let signature = body.dataset.signature || '';
    let pendingIds = idList(body.dataset.pendingIds);

    setupAlerts();
    setAttention(pendingIds.length);

    startPolling(function () {
      return fetchJson(base + 'api/sessions', '').then(function (update) {
        if (update === STOP) return STOP;
        if (!update) throw new Error('session list unavailable');
        if (update.signature !== signature) {
          signature = update.signature;
          list.innerHTML = update.html;
          formatTimes(list);
        }
        if (hasNewId(pendingIds, update.pendingIds)) {
          alertHuman(
            update.pendingIds.length === 1
              ? 'An AI is waiting for your answer.'
              : update.pendingIds.length + ' AIs are waiting for your answers.'
          );
        }
        pendingIds = update.pendingIds;
        setAttention(pendingIds.length);
      });
    }, LIST_POLL_MS);
  }

  // ── Chat ──

  function setFilesOpen(root, open) {
    root.querySelectorAll('.file-block').forEach(function (block) {
      block.open = open;
    });
  }

  /**
   * Highlights what arrived since the human last answered: every message after the last human
   * message, or all of them before the first answer.
   */
  function markRecentMessages(messagesEl) {
    const messages = messagesEl.querySelectorAll(':scope > .message');
    let answered = false;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].classList.contains('human')) answered = true;
      messages[i].classList.toggle('recent', !answered);
    }
  }

  function initChat() {
    const sessionId = body.dataset.sessionId;
    const returnTo = 'sessions/' + sessionId;
    const label = body.dataset.label || 'A session';
    const messagesEl = document.getElementById('messages');
    const form = document.getElementById('respond-form');
    const input = document.getElementById('response-input');
    const sendButton = document.getElementById('send-btn');
    const requestIdField = document.getElementById('request-id');
    const statusEl = document.getElementById('chat-status');
    const chatBanner = document.getElementById('chat-banner');
    const othersBadge = document.getElementById('others-waiting');
    const autoExpandBox = document.getElementById('auto-expand-files');
    const charCount = document.getElementById('char-count');
    const draftKey = 'tg:draft:' + sessionId;
    // Holds the request id an answer was sent for, until the next page load sees how it went.
    const sentKey = 'tg:sent:' + sessionId;
    const sendLabel = sendButton.textContent;

    let count = Number(body.dataset.count) || 0;
    let currentRequestId = requestIdField.value || null;
    let othersPending = idList(body.dataset.othersPending);
    let lastStatusHtml = statusEl.innerHTML;
    let submitting = false;

    /** Same count and wording as the server's charCountText: code points, so an emoji is one. */
    function renderCharCount() {
      const length = Array.from(input.value).length;
      charCount.textContent = length + ' character' + (length === 1 ? '' : 's');
    }

    /** Answer box, title and favicon, from the open question and the other sessions' ones. */
    function renderAnswerable() {
      const answerable = currentRequestId !== null;
      input.readOnly = !answerable;
      sendButton.disabled = !answerable || submitting;
      input.placeholder = answerable
        ? body.dataset.placeholderPending
        : body.dataset.placeholderIdle;
      setAttention((answerable ? 1 : 0) + othersPending.length);
      if (othersBadge) {
        const others = othersPending.length;
        othersBadge.hidden = others === 0;
        othersBadge.textContent = others + ' other' + (others === 1 ? '' : 's') + ' waiting';
      }
    }

    // The draft survives reloads and failed sends. It is dropped only when the server confirms
    // the send: a successful answer redirects back here with ?sent=<request id>.
    (function restoreDraft() {
      const serverDraft = input.value;
      const sentFor = storageGet('sessionStorage', sentKey);
      storageRemove('sessionStorage', sentKey);
      const pageUrl = new URL(location.href);
      const confirmedFor = pageUrl.searchParams.get('sent');
      if (confirmedFor !== null) {
        // A reload shouldn't read the confirmation again.
        pageUrl.searchParams.delete('sent');
        history.replaceState(history.state, '', pageUrl.pathname + pageUrl.search + pageUrl.hash);
      }

      if (serverDraft !== '') {
        // The server re-rendered the page around an answer it refused.
        storageSet('sessionStorage', draftKey, serverDraft);
      } else if (confirmedFor !== null && confirmedFor === sentFor) {
        storageRemove('sessionStorage', draftKey);
      } else {
        const saved = storageGet('sessionStorage', draftKey);
        if (!saved) return;
        input.value = saved;
        if (sentFor !== null && sentFor !== (currentRequestId || '')) {
          showBanner(
            chatBanner,
            'warn',
            'Your last answer may not have reached the server, and the question it answered ' +
              'is no longer open. Your draft is still here; check it still fits before sending.'
          );
        }
      }
    })();

    setupAlerts();
    renderAnswerable();
    renderCharCount();
    markRecentMessages(messagesEl);

    // The checkbox holds the live setting; storage only carries it to the next page.
    autoExpandBox.checked = storageGet('localStorage', AUTO_EXPAND_KEY) === 'on';
    if (autoExpandBox.checked) setFilesOpen(messagesEl, true);
    autoExpandBox.addEventListener('change', function () {
      storageSet('localStorage', AUTO_EXPAND_KEY, autoExpandBox.checked ? 'on' : 'off');
      setFilesOpen(messagesEl, autoExpandBox.checked);
    });

    messagesEl.scrollTop = messagesEl.scrollHeight;

    input.addEventListener('input', function () {
      storageSet('sessionStorage', draftKey, input.value);
      renderCharCount();
    });

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (!sendButton.disabled) sendButton.click();
      }
    });

    form.addEventListener('submit', function (event) {
      if (input.value.trim() === '') {
        event.preventDefault();
        showBanner(chatBanner, 'error', 'Your answer is empty. Type something before sending.');
        input.focus();
        return;
      }
      storageSet('sessionStorage', draftKey, input.value);
      storageSet('sessionStorage', sentKey, requestIdField.value);
      submitting = true;
      sendButton.disabled = true;
      sendButton.textContent = 'Sending…';
    });

    // Back/forward cache restores the page as it was mid-submit.
    window.addEventListener('pageshow', function (event) {
      if (!event.persisted) return;
      submitting = false;
      sendButton.textContent = sendLabel;
      renderAnswerable();
    });

    function isScrolledToBottom() {
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 48;
    }

    function applyUpdate(update) {
      if (update.count > count && update.html) {
        const followTail = isScrolledToBottom();
        const emptyNote = document.getElementById('no-messages');
        if (emptyNote) emptyNote.remove();
        const fresh = document.createElement('template');
        fresh.innerHTML = update.html;
        if (autoExpandBox.checked) setFilesOpen(fresh.content, true);
        messagesEl.append(fresh.content);
        markRecentMessages(messagesEl);
        formatTimes(messagesEl);
        if (followTail) messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      count = update.count;

      if (update.statusHtml !== lastStatusHtml) {
        lastStatusHtml = update.statusHtml;
        statusEl.innerHTML = update.statusHtml;
        formatTimes(statusEl);
      }

      let alertText = null;
      if (hasNewId(othersPending, update.othersPending)) {
        alertText =
          update.othersPending.length === 1
            ? 'Another session needs your answer.'
            : update.othersPending.length + ' other sessions need your answers.';
      }
      othersPending = update.othersPending;

      const nextRequestId = update.pending ? update.pending.requestId : null;
      if (nextRequestId !== currentRequestId) {
        if (nextRequestId !== null) {
          if (input.value.trim() !== '') {
            showBanner(
              chatBanner,
              'warn',
              'The AI sent a new message while you were typing. Your draft is still here; ' +
                'check it still fits before sending.'
            );
          }
          alertText = label + ' needs your answer.';
        }
        currentRequestId = nextRequestId;
        requestIdField.value = nextRequestId || '';
      }
      renderAnswerable();
      if (alertText) alertHuman(alertText);
    }

    startPolling(function () {
      const url =
        base + 'api/sessions/' + encodeURIComponent(sessionId) + '/updates?after=' + count;
      return fetchJson(url, returnTo).then(function (update) {
        if (update === STOP) return STOP;
        if (update === null) {
          showBanner(
            chatBanner,
            'error',
            'This session was deleted. Nothing more will arrive here.'
          );
          statusEl.textContent = 'Session deleted.';
          currentRequestId = null;
          requestIdField.value = '';
          renderAnswerable();
          return STOP;
        }
        applyUpdate(update);
        return undefined;
      });
    }, CHAT_POLL_MS);
  }

  formatTimes(document.body);
  setInterval(tickLiveTimes, 1000);

  if (body.dataset.page === 'sessions') {
    initSessionList();
  } else if (body.dataset.page === 'chat') {
    initChat();
  }
})();
