(function () {
  'use strict';
  const REQUIRED = ['api', 'state', 'openSettingsAt', 'showToast'];
  let ctx, active;
  const drafts = new Map();
  const sessions = new Map();
  function ownerKey(project) {
    return JSON.stringify([ctx.state.user?.id ?? ctx.state.user?.username ?? null, ctx.state.hostIdentity?.instanceId ?? location.origin, ctx.state.activeHostId, project.id]);
  }
  function preference(project, partial) {
    return ctx.workspacePreference ? ctx.workspacePreference(project.id, partial) : {};
  }

  function init(context) {
    for (const key of REQUIRED) if (context[key] === undefined) throw new Error(`chat.js requires ${key}`);
    ctx = context;
  }
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function button(text, run, className) {
    const element = node('button', text, className || 'btn btn-secondary btn-sm');
    element.type = 'button'; element.onclick = run;
    return element;
  }
  function fit(view) {
    const element = view.input;
    element.style.height = 'auto';
    if (element.scrollHeight) element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }
  const COMMANDS = [
    ['/new', 'Start a new session; keep history'],
    ['/reset', 'Confirm a fresh session; keep history'],
    ['/context', 'Latest assistant token usage and configured context window'],
    ['/model', 'View AI Gateway mode routing'],
    ['/help', 'Commands and tool activity help']
  ];
  function commandMenu(view, dismiss = false) {
    const match = /^\/[^\s]*$/.test(view.input.value);
    view.commandItems = match && !dismiss ? COMMANDS.filter(([name]) => name.startsWith(view.input.value.toLowerCase())) : [];
    view.commandIndex = Math.min(view.commandIndex || 0, Math.max(0, view.commandItems.length - 1));
    view.commandList.replaceChildren();
    view.commandList.hidden = !view.commandItems.length;
    view.input.setAttribute('aria-expanded', String(!view.commandList.hidden));
    view.input.removeAttribute('aria-activedescendant');
    view.commandItems.forEach(([name, description], index) => {
      const item = node('div', `${name} — ${description}`, 'chat-command-option');
      item.id = `chat-command-${index}`; item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === view.commandIndex));
      item.onmousedown = event => event.preventDefault();
      item.onclick = () => chooseCommand(view, name);
      view.commandList.append(item);
      if (index === view.commandIndex) view.input.setAttribute('aria-activedescendant', item.id);
    });
  }
  function chooseCommand(view, name) {
    view.input.value = name; commandMenu(view, true); controls(view); view.input.focus();
    runCommand(view);
  }
  function infoPanel(view, title) {
    view.info.replaceChildren(node('strong', title), button('Dismiss', () => { view.info.hidden = true; view.input.focus(); }, 'chat-link'));
    view.info.hidden = false;
    return view.info;
  }
  async function runCommand(view, text = view.input.value) {
    if (!text.trimStart().startsWith('/')) return false;
    if (!present(view)) return true;
    const editRevision = view.editRevision || 0;
    const command = text.trim().toLowerCase();
    if (!COMMANDS.some(([name]) => name === command)) {
      infoPanel(view, 'Unknown command').append(node('p', 'Use /help to see commands. Commands do not accept arguments.'));
      return true;
    }
    commandMenu(view, true);
    const selection = view.selection;
    if (command === '/new') {
      if (!view.ready || view.loading || view.offline) { infoPanel(view, 'New chat unavailable').append(node('p', 'Reconnect Chat before creating a session.')); return true; }
      await create(view);
      if (view.selection === selection) return true;
    } else if (command === '/reset') {
      const panel = infoPanel(view, 'Start a fresh session?');
      panel.append(node('p', 'Prior messages are retained in Session history. This creates a new session; it does not delete history or cancel running work.'));
      const confirm = button('Confirm new session', async () => {
        if (!present(view, selection) || view.loading || !view.ready || view.offline) return;
        confirm.disabled = true; await create(view);
        if (present(view)) { confirm.disabled = false; if (view.selection !== selection) panel.hidden = true; }
      });
      panel.append(confirm, button('Keep current session', () => { panel.hidden = true; view.input.focus(); }));
    } else if (command === '/help') {
      const panel = infoPanel(view, 'Chat commands');
      for (const [name, description] of COMMANDS) panel.append(node('p', `${name} — ${description}`));
      panel.append(node('p', 'Arrow keys select commands; Enter chooses; Escape closes suggestions. Ctrl+Enter sends. Tool activity expands to show tool names and status only, not raw inputs. Permission requests require separate approval.'));
    } else if (command === '/model') {
      const panel = infoPanel(view, 'AI Gateway models');
      for (const role of ['plan', 'build']) panel.append(node('p', `${role === 'plan' ? 'Plan' : 'Build'}: ${selection?.snapshot?.models?.[role]?.model || 'unknown'}`));
      panel.append(node('p', `Selected mode: ${view.role.value}. Routing is managed by AI Gateway; native provider selection is disabled.`));
      const other = view.role.value === 'plan' ? 'build' : 'plan';
      const switchMode = button(`Switch to ${other === 'plan' ? 'Plan' : 'Build'}`, () => {
        if (!present(view, selection) || view.role.disabled) return;
        view.role.value = other; panel.hidden = true; view.input.focus();
      });
      switchMode.disabled = view.role.disabled; panel.append(switchMode);
    } else {
      const panel = infoPanel(view, 'Latest assistant usage');
      const snapshot = selection?.snapshot;
      const latest = snapshot?.messages?.filter(message => message.role === 'assistant').at(-1);
      const tokens = latest?.tokens;
      const configured = snapshot?.models?.[view.role.value];
      const value = number => typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number.toLocaleString() : 'unknown';
      panel.append(node('p', `Selected gateway model: ${configured?.model || 'unknown'}. Configured context window: ${value(configured?.limitTokens)} tokens.`));
      panel.append(node('p', `Latest assistant model: ${latest?.model || 'unknown'}${selection?.fresh ? '' : ' (snapshot may be stale)'}.`));
      panel.append(node('p', `Input: ${value(tokens?.input)}; output: ${value(tokens?.output)}; reasoning: ${value(tokens?.reasoning)}; cache read: ${value(tokens?.cache?.read)}; cache write: ${value(tokens?.cache?.write)}.`));
      panel.append(node('p', 'Latest request input context = input + cache read + cache write. Output and reasoning are reported separately and may overlap; they are not added. These are not session totals or a live context percentage.'));
      const inputs = [tokens?.input, tokens?.cache?.read, tokens?.cache?.write];
      panel.append(node('p', `Latest request input context: ${inputs.every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0) && inputs.reduce((a, b) => a + b, 0) <= Number.MAX_SAFE_INTEGER ? value(inputs.reduce((a, b) => a + b, 0)) : 'unknown'} tokens.`));
    }
    if (present(view) && view.input.value === text && (view.editRevision || 0) === editRevision) view.input.value = '';
    if (present(view)) controls(view);
    return true;
  }
  const SUGGESTIONS = [
    ['Explain this project', 'Explain how this project is structured and where I should start reading.'],
    ['Find bugs', 'Review the most recent changes and point out bugs or risky code.'],
    ['Write tests', 'Suggest and write missing tests for the core modules.'],
    ['Plan a feature', 'Help me plan a new feature: ask what you need and outline the steps.']
  ];
  function renderWelcome(view, hasSession) {
    const welcome = node('div', undefined, 'chat-welcome');
    welcome.append(node('span', 'C', 'chat-mark'), node('h2', 'What can I help you build?'), node('p', hasSession ? `Working in ${view.project.name}` : 'Start a new chat to begin.', 'chat-welcome-sub'));
    welcome.firstChild.setAttribute('aria-hidden', 'true');
    const grid = node('div', undefined, 'chat-suggestions');
    for (const [title, text] of SUGGESTIONS) {
      const suggestion = button(title, () => { view.input.value = text; fit(view); controls(view); view.input.focus(); }, 'chat-suggestion');
      grid.append(suggestion);
    }
    welcome.append(grid);
    view.log.replaceChildren(welcome);
  }
  function stopSelection(view) {
    const selection = view.selection;
    if (!selection) return;
    selection.source?.close(); clearTimeout(selection.timer);
    view.selection = null;
  }
  function close(options = {}) {
    const view = active;
    if (!view) return;
    drafts.set(view.key, { text: view.input.value, role: view.role.value });
    active = null; stopSelection(view); view.observer.disconnect();
    document.removeEventListener('visibilitychange', view.onVisibility);
    window.removeEventListener('offline', view.onOffline);
    window.removeEventListener('online', view.onOnline);
    view.panel.remove(); view.content.classList.remove('chat-host');
    for (const { element, inert } of view.mounted) if (!inert) element.removeAttribute('inert');
    view.content.scrollTop = view.scrollTop;
    if (view.returnTarget?.isConnected) view.returnTarget.focus({ preventScroll: true });
    if (options.explicit) view.onClose?.();
  }
  function reset() {
    close(); drafts.clear(); sessions.clear();
  }
  function present(view, selection) {
    return active === view && view.panel.isConnected && ctx.state.activeHostId === view.host && ownerKey(view.project) === view.key && (!selection || view.selection === selection);
  }
  function safeText(parent, text) {
    const chunks = String(text || '').split(/```[^\n`]*\n([\s\S]*?)(?:```|$)/g);
    chunks.forEach((chunk, index) => {
      if (index % 2) { const pre = node('pre'); pre.append(node('code', chunk)); parent.append(pre); }
      else if (chunk) parent.append(node('div', chunk, 'chat-text'));
    });
  }
  async function open(project, options = {}) {
    if (ctx.state.activeHostId !== 'local') {
      ctx.showToast('Open this machine’s own Citadel panel to use Chat.', 'error'); return;
    }
    close();
    const content = options.content || document.getElementById('main-content');
    if (!content) return;
    const panel = node('section', undefined, 'chat-panel');
    panel.setAttribute('aria-label', `Chat: ${project.name}`);
    const view = { key: ownerKey(project), onClose: options.onClose, panel, content, host: ctx.state.activeHostId, project, selection: null, ready: false, loading: false, offline: window.navigator.onLine === false,
      returnTarget: document.activeElement, scrollTop: content.scrollTop,
      mounted: [...content.children].map(element => ({ element, inert: element.hasAttribute('inert') })) };
    active = view;
    for (const { element } of view.mounted) element.setAttribute('inert', '');
    content.classList.add('chat-host'); content.append(panel); content.scrollTop = 0;
    view.observer = new MutationObserver(() => { if (active === view && !panel.isConnected) close(); });
    view.observer.observe(content, { childList: true });
    view.menu = node('details', undefined, 'chat-menu');
    const summary = node('summary', 'Chat options');
    const tools = node('div', undefined, 'chat-menu-items');
    const back = button('Choose workspace mode', () => close({ explicit: true }), 'chat-back');
    view.sessions = node('select', undefined, 'chat-sessions');
    view.sessions.setAttribute('aria-label', 'Chat session history');
    view.sessions.onchange = () => { select(view, view.sessions.value); view.menu.open = false; view.input.focus(); };
    view.newButton = button('New chat', () => { view.menu.open = false; view.input.focus(); create(view); }, 'chat-new');
    const history = node('label', 'Session history'); history.append(view.sessions);
    if (!options.content) tools.append(back);
    tools.append(history, view.newButton, button('Command help', () => { runCommand(view, '/help'); view.menu.open = false; }));
    view.menu.append(summary, tools);
    view.notices = node('div', undefined, 'chat-notices'); view.notices.hidden = true;
    view.notice = node('p'); view.notice.setAttribute('role', 'status');
    view.notices.append(view.notice, button('Settings', () => ctx.openSettingsAt('gateway'), 'chat-link'), button('Reconnect', () => load(view), 'chat-link'));
    view.log = node('div', undefined, 'chat-log'); view.log.setAttribute('role', 'log'); view.log.setAttribute('aria-label', 'Messages');
    view.prompts = node('div', undefined, 'chat-prompts');
    const composer = node('form', undefined, 'chat-composer');
    const box = node('div', undefined, 'chat-box');
    view.input = node('textarea', undefined, 'chat-input'); view.input.rows = 1; view.input.maxLength = 32000;
    view.input.placeholder = 'Message Chat'; view.input.setAttribute('aria-label', 'Message');
    view.commandList = node('div', undefined, 'chat-command-list'); view.commandList.id = 'chat-command-list';
    view.commandList.hidden = true; view.commandList.setAttribute('role', 'listbox'); view.commandList.setAttribute('aria-label', 'Chat commands');
    view.input.setAttribute('aria-controls', view.commandList.id); view.input.setAttribute('aria-autocomplete', 'list'); view.input.setAttribute('aria-expanded', 'false');
    view.input.oninput = () => { view.editRevision = (view.editRevision || 0) + 1; view.commandIndex = 0; fit(view); controls(view); commandMenu(view); };
    view.input.onkeydown = event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); commandMenu(view, true); return; }
      if (!event.ctrlKey && !event.metaKey && !view.commandList.hidden) {
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault(); view.commandIndex = (view.commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + view.commandItems.length) % view.commandItems.length; commandMenu(view); return;
        }
        if (event.key === 'Enter') { event.preventDefault(); chooseCommand(view, view.commandItems[view.commandIndex][0]); return; }
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); composer.requestSubmit(); }
    };
    view.role = node('select', undefined, 'chat-role'); view.role.setAttribute('aria-label', 'Agent mode');
    for (const role of ['build', 'plan']) { const option = node('option', role === 'build' ? 'Build' : 'Plan'); option.value = role; view.role.append(option); }
    const draft = drafts.get(view.key);
    if (draft) { view.input.value = draft.text; view.role.value = draft.role; }
    view.send = button('Send', () => {}, 'chat-send'); view.send.type = 'submit';
    view.stop = button('Stop', () => action(view, view.selection, 'cancel', {}), 'chat-stop');
    const actions = node('div', undefined, 'chat-composer-actions'); actions.append(view.menu, view.role, node('span', 'Ctrl+Enter to send', 'chat-hint'), view.stop, view.send);
    box.append(view.commandList, view.input, actions);
    view.info = node('section', undefined, 'chat-command-info'); view.info.hidden = true; view.info.setAttribute('aria-label', 'Command information'); view.info.setAttribute('aria-live', 'polite');
    composer.append(view.notices, view.info, box); composer.onsubmit = event => { event.preventDefault(); send(view); };
    panel.append(view.log, view.prompts, composer);
    renderWelcome(view, false);
    view.onOffline = () => {
      if (!present(view)) return;
      view.offline = true;
      if (view.selection) invalidate(view, view.selection);
      notice(view, 'Chat offline. The agent may still be running; Stop cancels it.');
    };
    view.onOnline = () => {
      if (!present(view)) return;
      if (window.navigator.onLine === false) { view.onOffline(); return; }
      view.offline = false;
      if (view.selection) { invalidate(view, view.selection); schedule(view, view.selection); }
    };
    view.onVisibility = () => {
      if (document.visibilityState === 'visible') view.onOnline();
    };
    document.addEventListener('visibilitychange', view.onVisibility);
    window.addEventListener('offline', view.onOffline);
    window.addEventListener('online', view.onOnline);
    controls(view); view.input.focus(); await load(view);
  }
  function notice(view, text = '') {
    view.notice.textContent = text;
    view.notices.hidden = !text;
  }
  function base(view) { return `/api/projects/${encodeURIComponent(view.project.id)}/chat/sessions`; }
  function path(view, selection) { return `${base(view)}/${encodeURIComponent(selection.id)}`; }
  function invalidate(view, selection) {
    selection.revision++;
    selection.fresh = false;
    controls(view);
  }
  function controls(view) {
    const selection = view.selection;
    const locked = !view.ready || view.offline || !selection?.fresh || selection.pending;
    view.send.disabled = view.input.value.trimStart().startsWith('/') ? false : Boolean(locked || selection?.status !== 'idle' || !view.input.value.trim());
    view.stop.disabled = Boolean(!selection?.loaded || selection.pending || (selection.fresh && selection.status !== 'busy'));
    view.prompts.querySelectorAll('button').forEach(element => { element.disabled = Boolean(locked); });
    view.role.disabled = Boolean(locked || selection?.status === 'busy');
    view.sessions.disabled = view.loading;
    view.newButton.disabled = !view.ready || view.loading;
    view.panel.classList.toggle('chat-busy', Boolean(selection?.fresh && selection.status === 'busy'));
    fit(view);
  }
  async function load(view) {
    if (!present(view) || view.loading) return;
    view.loading = true; view.ready = false; stopSelection(view); controls(view);
    try {
      const status = await ctx.api('/api/chat/status');
      if (!present(view)) return;
      view.installed = status.installed; view.ready = status.ready === true;
      if (!view.ready) { notice(view, status.error || 'Chat needs OpenCode and AI Gateway. Native provider fallback is disabled.'); return; }
      const result = await ctx.api(base(view));
      if (!present(view)) return;
      view.sessions.replaceChildren();
      for (const session of result.sessions || []) addSession(view, session);
      const remembered = preference(view.project).chatSessionId || sessions.get(view.key);
      if ([...view.sessions.options].some(option => option.value === remembered)) view.sessions.value = remembered;
      if (view.sessions.value) select(view, view.sessions.value);
      else await createSession(view);
    } catch (err) { if (present(view)) notice(view, err.message); }
    finally { if (present(view)) { view.loading = false; controls(view); } }
  }
  function addSession(view, session) {
    const option = node('option', session.title || 'Untitled chat'); option.value = session.id;
    option.title = session.updatedAt || ''; view.sessions.append(option);
  }
  async function create(view) {
    if (!present(view) || view.loading || !view.ready) return;
    view.loading = true; controls(view);
    try {
      await createSession(view);
    } catch (err) { if (present(view)) notice(view, err.message); }
    finally { if (present(view)) { view.loading = false; controls(view); } }
  }
  async function createSession(view) {
    const { session } = await ctx.api(base(view), { method: 'POST', body: {} });
    if (!present(view)) return;
    addSession(view, session); view.sessions.value = session.id; select(view, session.id);
  }
  function select(view, id) {
    if (!present(view)) return;
    notice(view); view.info.hidden = true;
    stopSelection(view); view.log.replaceChildren(); view.prompts.replaceChildren();
    if (!id || !present(view)) { renderWelcome(view, false); controls(view); return; }
    sessions.set(view.key, id);
    preference(view.project, { chatSessionId: id });
    renderWelcome(view, true);
    const selection = { id, loaded: false, fresh: false, revision: 0, pending: false, dirty: false, fetching: false, timer: null, status: 'idle', prompts: '' };
    view.selection = selection; controls(view);
    try {
      selection.source = new window.EventSource(`${path(view, selection)}/events`);
      selection.source.addEventListener('update', () => schedule(view, selection));
      selection.source.onopen = () => {
        if (!present(view, selection)) return;
        invalidate(view, selection);
        schedule(view, selection);
      };
      selection.source.onerror = () => {
        if (!present(view, selection)) return;
        invalidate(view, selection);
        clearTimeout(selection.timer); selection.timer = null; selection.dirty = false;
        notice(view, 'Chat disconnected. The agent may still be running. Reconnecting; Stop cancels it.');
      };
    } catch { selection.streamUnavailable = true; notice(view, 'Live updates unavailable. Reconnect to refresh Chat.'); }
    refresh(view, selection);
  }
  function schedule(view, selection) {
    if (!present(view, selection)) return;
    selection.dirty = true;
    if (selection.fetching || selection.timer) return;
    selection.timer = setTimeout(() => { selection.timer = null; refresh(view, selection); }, 250);
  }
  async function refresh(view, selection) {
    if (!present(view, selection) || selection.fetching) return;
    selection.fetching = true; selection.dirty = false;
    const revision = selection.revision;
    try {
      const snapshot = await ctx.api(path(view, selection));
      if (!present(view, selection) || revision !== selection.revision || view.offline) return;
      selection.snapshot = snapshot;
      selection.loaded = true; selection.fresh = snapshot.status !== 'error'; selection.status = snapshot.status;
      const nearBottom = view.log.scrollHeight - view.log.scrollTop - view.log.clientHeight < 100;
      view.log.replaceChildren();
      const messages = (snapshot.messages || []).filter(message => (message.parts || []).some(part => part.type === 'text' || part.type === 'tool'));
      if (!messages.length) renderWelcome(view, true);
      const thread = node('div', undefined, 'chat-thread');
      for (const message of messages) {
        const user = message.role === 'user';
        const article = node('article', undefined, `chat-message chat-${user ? 'user' : 'assistant'}`);
        const avatar = node('span', user ? 'You' : 'C', 'chat-avatar'); avatar.setAttribute('aria-hidden', 'true');
        const body = node('div', undefined, 'chat-body');
        body.append(node('strong', user ? 'You' : 'Assistant', 'chat-author'));
        let tools;
        for (const part of message.parts || []) {
          if (part.type === 'text') { tools = null; safeText(body, part.text); }
          else if (part.type === 'tool') {
            if (!tools) { tools = node('details', undefined, 'chat-tools'); tools.append(node('summary', 'Tool activity')); body.append(tools); }
            tools.append(node('div', `${part.text || 'tool'} · ${part.state?.status || 'pending'}`, 'chat-tool'));
          }
        }
        article.append(avatar, body); thread.append(article);
      }
      if (messages.length) {
        if (snapshot.status === 'busy' && !snapshot.permissions?.length && !snapshot.questions?.length) {
          const typing = node('div', undefined, 'chat-typing'); typing.setAttribute('aria-hidden', 'true');
          typing.append(node('i'), node('i'), node('i')); thread.append(typing);
        }
        view.log.append(thread);
      }
      if (nearBottom) view.log.scrollTop = view.log.scrollHeight;
      const option = [...view.sessions.options].find(item => item.value === selection.id);
      if (option && snapshot.session?.title) option.textContent = snapshot.session.title;
      notice(view, snapshot.status === 'error' ? 'Chat engine error. Check OpenCode and AI Gateway in Settings, then reconnect.' : selection.streamUnavailable ? 'Live updates unavailable. Reconnect to refresh Chat.' : '');
      const signature = JSON.stringify([snapshot.permissions || [], snapshot.questions || []]);
      if (selection.prompts !== signature) { selection.prompts = signature; renderPrompts(view, selection, snapshot); }
    } catch (err) {
      if (present(view, selection) && revision === selection.revision) { invalidate(view, selection); notice(view, err.message); }
    }
    finally {
      selection.fetching = false;
      if (present(view, selection)) { controls(view); if (selection.dirty) schedule(view, selection); }
    }
  }
  async function action(view, selection, suffix, body) {
    if (!selection || !present(view, selection) || selection.pending) return false;
    if (suffix === 'cancel' ? view.stop.disabled : !view.ready || view.offline || !selection.fresh || selection.status === 'error') return false;
    selection.pending = true; controls(view);
    view.prompts.querySelectorAll('button').forEach(element => { element.disabled = true; });
    try {
      await ctx.api(`${path(view, selection)}/${suffix}`, { method: 'POST', body });
      if (!present(view, selection)) return false;
      schedule(view, selection); return true;
    } catch (err) {
      if (present(view, selection)) { invalidate(view, selection); notice(view, err.message); schedule(view, selection); }
      return false;
    }
    finally {
      if (present(view, selection)) {
        selection.pending = false; controls(view);

      }
    }
  }
  async function send(view) {
    if (view.input.value.trimStart().startsWith('/')) { await runCommand(view); return; }
    const selection = view.selection, text = view.input.value, role = view.role.value;
    if (view.send.disabled || !selection) return;
    if (!selection.attempt || selection.attempt.text !== text || selection.attempt.role !== role) selection.attempt = { text, role, requestId: window.crypto.randomUUID() };
    if (await action(view, selection, 'messages', selection.attempt)) {
      if (!present(view, selection)) return;
      selection.status = 'busy'; selection.attempt = null;
      if (view.input.value === text) view.input.value = '';
      controls(view);
    }
  }
  function renderPrompts(view, selection, snapshot) {
    view.prompts.replaceChildren();
    for (const permission of snapshot.permissions || []) {
      const card = node('section', undefined, 'chat-prompt');
      card.append(node('strong', `Permission: ${permission.permission}`));
      for (const pattern of permission.patterns || []) card.append(node('div', pattern, 'chat-text'));
      const suffix = `permissions/${encodeURIComponent(permission.id)}/reply`;
      card.append(button('Allow once', () => action(view, selection, suffix, { reply: 'once' })), button('Reject', () => action(view, selection, suffix, { reply: 'reject' })));
      view.prompts.append(card);
    }
    for (const request of snapshot.questions || []) {
      const form = node('form', undefined, 'chat-prompt');
      const readers = [];
      for (const [index, question] of (request.questions || []).entries()) {
        const group = node('fieldset'); group.append(node('legend', question.header || 'Question'), node('p', question.question));
        const choices = [];
        for (const option of question.options || []) {
          const label = node('label', undefined, 'chat-choice'), input = node('input');
          input.type = question.multiple ? 'checkbox' : 'radio'; input.name = `question-${index}`; input.value = option.label;
          choices.push(input); label.append(input, node('span', `${option.label}${option.description ? ` — ${option.description}` : ''}`)); group.append(label);
        }
        let custom, customChoice;
        if (question.custom !== false) {
          const label = node('label', undefined, 'chat-choice'); customChoice = node('input');
          customChoice.type = question.multiple ? 'checkbox' : 'radio'; customChoice.name = `question-${index}`;
          custom = node('input', undefined, 'form-input'); custom.type = 'text'; custom.maxLength = 2000; custom.setAttribute('aria-label', `${question.header || 'Question'} custom answer`);
          custom.oninput = () => { customChoice.checked = Boolean(custom.value.trim()); };
          label.append(customChoice, node('span', 'Custom answer'), custom); group.append(label);
        }
        readers.push(() => [...choices.filter(input => input.checked).map(input => input.value), ...(customChoice?.checked && custom.value.trim() ? [custom.value.trim()] : [])]);
        form.append(group);
      }
      const suffix = `questions/${encodeURIComponent(request.id)}`;
      const submit = button('Answer', () => {}); submit.type = 'submit';
      form.onsubmit = event => {
        event.preventDefault(); const answers = readers.map(read => read());
        if (answers.some(answer => !answer.length)) { notice(view, 'Choose or enter an answer for each question, or reject the request.'); return; }
        action(view, selection, `${suffix}/reply`, { answers });
      };
      form.append(submit, button('Reject question', () => action(view, selection, `${suffix}/reject`, {}))); view.prompts.append(form);
    }
    view.prompts.querySelectorAll('button').forEach(element => { element.disabled = selection.pending; });
  }
  window.CitadelChat = { init, open, close, reset };
})();
