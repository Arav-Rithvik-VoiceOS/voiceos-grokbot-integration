/* Confirmation bridge for the unchanged thread.html handoff.
 * VoiceOS owns approval: this iframe stages edits, never invokes a send tool.
 * The host's floating arrow occupies the composer slot reserved by the CSS.
 */
const packageBoot = boot;
let confirmationBooted = false;
const normalizeName = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function lookup(list, value) {
  const id = list.find(item => item.id === value);
  if (id) return id;
  const name = normalizeName(value);
  const exact = name ? list.filter(item => normalizeName(item.name) === name) : [];
  if (exact.length === 1) return exact[0];
  return null;
}
function confirmationPayload(data, args) {
  // The read-only lookup passes a fresh roster through host arguments. The
  // frozen manifest remains a fallback for cards opened without voice lookup.
  if (args.confirmationContext !== undefined) {
    try {
      const live = JSON.parse(args.confirmationContext);
      if (!Array.isArray(live.bots) || !Array.isArray(live.groups) ||
          ![...live.bots, ...live.groups].every(b => b && typeof b.id === 'string' && typeof b.name === 'string') ||
          !live.groups.every(g => Array.isArray(g.members))) throw new Error('Invalid roster');
      data = { ...data, bots: live.bots, groups: live.groups, threads: live.threads || {} };
    } catch {
      return { data, args, error: 'Could not verify the recipients. Close this card and try the message again.' };
    }
  }
  const d = { ...data, bots: [...(data.bots || [])], groups: [...(data.groups || [])] };
  const a = { ...args };
  if (data.tool === 'grokbot_send') {
    const bot = lookup(d.bots, a.bot);
    if (bot) a.bot = bot.id;
    else return { data: d, args: a, error: 'That bot could not be found. If you just created it, it may not be available yet. Close this card and try again.' };
    d.thread = data.threads?.[a.bot] || [];
  } else {
    let group = a.group ? lookup(d.groups, a.group) : null;
    if (a.group && !group) return { data: d, args: a, error: 'That group could not be found. Close this card and check its name.' };
    const tokens = Array.isArray(a.members) ? a.members : String(a.members || '').split(',').map(x => x.trim()).filter(Boolean);
    const requested = a.members === undefined && group ? group.members : tokens;
    if (requested.some(token => !lookup(d.bots, token))) return { data: d, args: a, error: 'One or more bots could not be found. Close this card and check the recipients.' };
    a.members = a.members === undefined && group ? group.members.slice() : tokens.map(token => {
      const bot = lookup(d.bots, token);
      if (bot) return bot.id;
      return token;
    });
    a.members = [...new Set(a.members)];
    if (!group && !a.group && a.members.length >= 2) {
      const matches = d.groups.filter(g => g.members.length === a.members.length && g.members.every(id => a.members.includes(id)));
      if (matches.length === 1) group = matches[0];
    }
    if (group) {
      a.group = group.id;
      if (a.groupName === undefined) a.groupName = group.name;
      // The package uses G.members, so overlay the requested edits there too.
      d.groups = d.groups.map(g => g.id === group.id ? { ...g, members: a.members, thread: data.threads?.[g.id] || [] } : g);
    }
  }
  return { data: d, args: a };
}
// Suppress the package's standalone fallback until real tool arguments arrive.
boot = function() {};
stage = function(key, value) {
  // ConfirmationWidget accepts primitive values only; arrays are ignored.
  if (key === 'members' && Array.isArray(value)) value = value.join(',');
  parent.postMessage({ type: 'voiceos:updateInput', key, value }, '*');
};
wireComposer = function(root) {
  const form = root.querySelector('#compose');
  form.querySelector('.plus')?.remove();
  const button = form.querySelector('.send');
  button.type = 'button';
  button.hidden = true;
  form.addEventListener('submit', event => event.preventDefault());
};
addEventListener('message', event => {
  if (event.data?.type !== 'voiceos:init') return;
  event.stopImmediatePropagation();
  if (event.source !== parent || confirmationBooted) return;
  confirmationBooted = true;
  inited = true;
  document.documentElement.classList.add('thread-confirmation');
  const payload = confirmationPayload(DEMO.data, event.data.args || {});
  if (payload.error) {
    // Never boot the package's fallback thread for an unresolved recipient.
    // The host owns its approval button; clearing the draft prevents a send.
    stage('message', '');
    const status = document.createElement('p');
    status.textContent = payload.error;
    status.setAttribute('role', 'status');
    status.style.cssText = 'padding:24px;color:var(--ink-2);font:14px/1.5 system-ui';
    document.body.replaceChildren(status);
    report();
    return;
  }
  packageBoot(payload.data, payload.args, event.data.theme?.mode || 'dark');
  for (const key of ['bot', 'group', 'members', 'groupName']) {
    if (payload.args[key] !== undefined) stage(key, payload.args[key]);
  }
  const name = document.querySelector('#gname');
  if (name) name.addEventListener('input', () => { A.groupName = name.value; });
}, true);
