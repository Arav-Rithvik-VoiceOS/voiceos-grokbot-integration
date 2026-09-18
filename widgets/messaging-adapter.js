/* Runtime adapter for the unmodified messaging handoff. Runs in its lexical scope. */
let canInvoke = false;
let pendingSend = null;
let sequence = 0;
let booted = false;
let themeMode = 'dark';
const originalBoot = boot;
boot = function(data, args, mode) {
  if (booted) return;
  booted = true;
  themeMode = mode;
  originalBoot(data, args, mode);
  // Keep late host capability/theme updates from resetting a user's draft.
  const name = document.querySelector('#gname');
  if (name) name.addEventListener('input', () => { A.groupName = name.value; });
};
// Capture first: the host often supplies {} data and no args for result widgets.
// Fall back to the server's baked live payload, never the package's demo roster.
addEventListener('message', event => {
  if (event.data?.type !== 'voiceos:init') return;
  event.stopImmediatePropagation();
  if (event.source !== parent) return;
  const m = event.data;
  canInvoke = m.capabilities?.invokeTool === true;
  themeMode = m.theme?.mode || themeMode;
  document.documentElement.dataset.theme = themeMode;
  inited = true;
  boot(m.data && Object.keys(m.data).length ? m.data : DEMO.data,
    { ...DEMO.args, ...m.args }, themeMode);
}, true);

function sendStatus(message, bad = false) {
  let status = document.querySelector('#send-status');
  if (!status) {
    status = document.createElement('div');
    status.id = 'send-status'; status.className = 'sys';
    status.setAttribute('role', 'status');
    document.querySelector('#c').before(status);
  }
  status.textContent = message;
  status.style.color = bad ? 'var(--bad)' : 'var(--ink-3)';
  report();
}
function unpackResult(result) {
  if (result?.isError) throw new Error('The send failed. Your draft is still here.');
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find(block => block.type === 'text')?.text;
  return typeof text === 'string' ? JSON.parse(text) : result;
}
function finishSend(status, result, error) {
  const pending = pendingSend;
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingSend = null;
  if (status === 'completed') {
    try {
      const body = unpackResult(result);
      if (body?.sent !== true) throw new Error(body?.message || 'The send was not confirmed.');
      const receipt = body.receipt;
      if (!receipt?.html) {
        // Completed is final even if the host omitted its large result. Never resend.
        sendStatus('Sent. Open the conversation to see the latest messages.');
        return;
      }
      stage('message', '');
      // Host toolResult deliberately strips _voiceos_glance. The server also
      // returns this receipt as data so the calling widget can show 1D / 1K.
      const html = receipt.html.replace('<meta charset="utf-8" />',
        '<meta charset="utf-8" /><meta name="voiceos-receipt-theme" content="' + themeMode + '">');
      document.open(); document.write(html); document.close();
      return;
    } catch (cause) { error = cause.message; status = 'failed'; }
  }
  if (status === 'unknown') {
    sendStatus('Delivery is unconfirmed. Check Grok Bot before sending again.', true);
    return; // Keep send locked: a timed-out request may already have acted.
  }
  document.querySelectorAll('#v-thread input, #v-thread button').forEach(el => el.disabled = false);
  const input = document.querySelector('#msg');
  document.querySelector('.send').disabled = !input.value.trim();
  sendStatus(status === 'cancelled' ? 'Cancelled — your draft is still here.' : (error || 'Not sent. Your draft is still here.'), true);
}
addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'voiceos:toolResult') return;
  const m = event.data;
  if (!pendingSend || pendingSend.requestId !== m.requestId) return;
  if (!['completed', 'failed', 'cancelled', 'unknown'].includes(m.status)) return;
  if (m.status === 'completed' && m.resultOmitted) {
    clearTimeout(pendingSend.timer); pendingSend = null;
    sendStatus('Sent. Open the conversation to see the latest messages.');
    return;
  }
  finishSend(m.status, m.result, m.error);
});
// Replace the demo's form submission callback, retaining its exact composer UI.
// VoiceOS uses allow-scripts without allow-forms, so use click / Enter events.
wireComposer = function(root) {
  const form = root.querySelector('#compose');
  form.querySelector('.plus')?.remove();
  const input = form.querySelector('#msg');
  const button = form.querySelector('.send');
  button.type = 'button';
  let locked = false;
  const go = () => {
    const message = input.value.trim();
    if (!message || pendingSend || locked) return;
    if (!canInvoke) { sendStatus('Sending is unavailable in this host. Your draft is still here.', true); return; }
    if (isGroup && members.length < (G ? 1 : 2)) {
      sendStatus(G ? 'Keep at least one bot in this group.' : 'Add at least two bots to start a group.', true); return;
    }
    // grokbot_card_send: same handlers as grokbot_send / grokbot_group, but no
    // manifest `confirmation` block — so the host never floats its "Confirm
    // action" dialog over the card. Typing + send here IS the user's approval.
    const args = isGroup
      ? { ...(G ? { group: G.id } : {}), members: members.slice(), groupName: document.querySelector('#gname').value, message }
      : { bot: A.bot, message };
    stage('message', message);
    if (isGroup) { stage('groupName', args.groupName); stage('members', args.members); }
    const requestId = 'send_' + Date.now() + '_' + (++sequence);
    document.querySelectorAll('#v-thread input, #v-thread button').forEach(el => el.disabled = true);
    sendStatus('Sending…');
    pendingSend = { requestId, timer: setTimeout(() => { locked = true; finishSend('unknown'); }, 65000) };
    parent.postMessage({ type: 'voiceos:invokeTool', name: 'grokbot_card_send', args, requestId }, '*');
  };
  form.addEventListener('submit', event => event.preventDefault());
  input.addEventListener('input', () => { button.disabled = !input.value.trim(); });
  button.addEventListener('click', event => { event.preventDefault(); go(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); go(); }
  });
};
// Group avatars remain a usable member-picker even with no selected members.
if (typeof stackHtml === 'function') {
  const originalStack = stackHtml;
  stackHtml = function() {
    return members.length ? originalStack() : '<button class="stack" id="stack" aria-label="Members">+</button>';
  };
}
const savedTheme = document.querySelector('meta[name="voiceos-receipt-theme"]')?.content;
if (savedTheme) themeMode = savedTheme;
// The package's fallback is useful for standalone files; production boots from
// the injected payload immediately so the card cannot flash sample content.
boot(DEMO.data, DEMO.args, themeMode);
