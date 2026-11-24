/** Sign in / sign up / password reset / username + avatar / profile screens. */
import { auth, api, friendlyError } from '../backend/supabase';
import type { AccountStore } from './account';
import { h, openModal, status, debounce, AVATARS } from './modal';

const GOOGLE_SVG = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

export function showAuth(account: AccountStore, mode: 'signin' | 'signup' | 'reset' = 'signin', reason?: string): void {
  const m = openModal(mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Sign in');
  const st = status();
  const email = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email', required: true });
  const pass = h('input', { type: 'password', placeholder: mode === 'signup' ? 'Password (8+ characters)' : 'Password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', minLength: 8, required: true });
  const submit = h('button', { class: 'primary', type: 'submit' }, mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in');

  const google = h('button', { class: 'google', type: 'button', onclick: async () => {
    st.set('Opening Google…');
    try { await auth.google(); } catch (e) { st.set(friendlyError(e) + ' (Is Google sign-in enabled in Supabase? See the README.)', 'err'); }
  } });
  google.innerHTML = `${GOOGLE_SVG}<span>Continue with Google</span>`;

  const form = h('form', { class: 'authForm', onsubmit: async (e: Event) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      if (mode === 'signin') { await auth.signIn(email.value.trim(), pass.value); m.close(); }
      else if (mode === 'signup') {
        if (pass.value.length < 8) throw new Error('Password must be at least 8 characters.');
        const r = await auth.signUp(email.value.trim(), pass.value);
        if (r.session) m.close();
        else st.set('Almost there! We sent you a confirmation email: click the link, then come back.', 'ok');
      } else {
        await auth.resetPassword(email.value.trim());
        st.set('If that email has an account, a reset link is on its way.', 'ok');
      }
    } catch (err) {
      const msg = friendlyError(err);
      st.set(msg === 'Invalid login credentials' ? 'Wrong email or password.' : msg === 'Email not confirmed' ? 'Please confirm your email first (check your inbox).' : msg, 'err');
    } finally { submit.disabled = false; }
  } }, h('label', {}, 'Email', email), mode !== 'reset' ? h('label', {}, 'Password', pass) : null, submit);

  const links = h('p', { class: 'authLinks' },
    mode !== 'signin' ? h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); showAuth(account, 'signin'); } }, 'I have an account') : null,
    mode !== 'signup' ? h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); showAuth(account, 'signup'); } }, 'Create an account') : null,
    mode !== 'reset' ? h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); showAuth(account, 'reset'); } }, 'Forgot password?') : null);

  m.body.append(
    reason ? h('p', { class: 'lead' }, reason) : '',
    mode !== 'reset' ? google : '',
    mode !== 'reset' ? h('div', { class: 'orLine' }, h('span', {}, 'or with email')) : '',
    form, st.el, links,
    h('p', { class: 'fine' }, '🔒 Your camera video never leaves your device. We store only your email, username, friends and scores.'));
}

export function showUsername(account: AccountStore, required: boolean): void {
  const current = account.profile;
  const m = openModal(current ? 'Change username' : 'Pick your username', { closable: true });
  const st = status();
  let avatar = current?.avatar ?? AVATARS[Math.floor(Math.random() * AVATARS.length)];
  const input = h('input', { type: 'text', value: current?.username ?? '', placeholder: 'e.g. smoke_ring_king', maxLength: 20, autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
  const avail = h('span', { class: 'avail' });
  const save = h('button', { class: 'primary', type: 'submit' }, current ? 'Save' : 'Let’s go');
  const check = debounce(async () => {
    const v = input.value.trim().toLowerCase();
    if (v === current?.username) { avail.textContent = ''; return; }
    if (!/^[a-z0-9_]{3,20}$/.test(v)) { avail.textContent = '3–20 letters, numbers, _'; avail.className = 'avail bad'; return; }
    avail.textContent = 'checking…'; avail.className = 'avail';
    try {
      const ok = await api.usernameAvailable(v);
      if (input.value.trim().toLowerCase() !== v) return;
      avail.textContent = ok ? '✓ available' : '✗ not available'; avail.className = 'avail ' + (ok ? 'good' : 'bad');
    } catch (e) { avail.textContent = friendlyError(e); avail.className = 'avail bad'; }
  }, 350);
  input.addEventListener('input', () => { input.value = input.value.toLowerCase().replace(/[^a-z0-9_]/g, ''); check(); });

  const grid = h('div', { class: 'avatarGrid' });
  const drawGrid = () => {
    grid.replaceChildren(...AVATARS.map(a => h('button', { type: 'button', class: 'av' + (a === avatar ? ' sel' : ''), onclick: () => { avatar = a; drawGrid(); } }, a)));
  };
  drawGrid();

  m.body.append(
    h('p', { class: 'lead' }, required ? 'Your username is how friends find you and how you appear on the leaderboard. It must be unique.' : 'You can change your username once a week.'),
    h('form', { class: 'authForm', onsubmit: async (e: Event) => {
      e.preventDefault();
      save.disabled = true;
      try {
        const p = await api.claimUsername(input.value, avatar);
        account.setProfile(p);
        m.close();
      } catch (err) { st.set(friendlyError(err), 'err'); }
      finally { save.disabled = false; }
    } }, h('label', {}, h('span', {}, 'Username ', avail), input), h('label', {}, 'Avatar', grid), save),
    st.el);
  if (current) check();
}

export function showProfile(account: AccountStore): void {
  const p = account.profile;
  if (!p) { showUsername(account, true); return; }
  const m = openModal('Your profile');
  const st = status();
  m.body.append(
    h('div', { class: 'profileHead' }, h('span', { class: 'bigAv' }, p.avatar), h('div', {}, h('b', {}, '@' + p.username), h('small', {}, account.email ?? ''))),
    h('div', { class: 'row' },
      h('button', { onclick: () => showUsername(account, false) }, '✏️ Change username / avatar'),
      h('button', { onclick: async () => { await account.signOut(); m.close(); } }, '🚪 Sign out')),
    h('details', { class: 'danger' },
      h('summary', {}, 'Delete account'),
      h('p', { class: 'fine' }, 'This permanently deletes your account, username, friends and scores.'),
      h('button', { class: 'dangerBtn', onclick: async () => {
        const typed = prompt(`Type your username (${p.username}) to delete your account forever:`);
        if (typed?.trim().toLowerCase() !== p.username) { st.set('Not deleted.', 'info'); return; }
        try { await api.deleteAccount(); await account.signOut(); m.close(); }
        catch (e) { st.set(friendlyError(e), 'err'); }
      } }, 'Delete my account')),
    st.el);
}

export function showNewPassword(): void {
  const m = openModal('Choose a new password');
  const st = status();
  const pass = h('input', { type: 'password', minLength: 8, autocomplete: 'new-password', placeholder: 'New password (8+ characters)' });
  m.body.append(h('form', { class: 'authForm', onsubmit: async (e: Event) => {
    e.preventDefault();
    try { await auth.updatePassword(pass.value); st.set('Password updated ✓', 'ok'); setTimeout(() => m.close(), 1200); }
    catch (err) { st.set(friendlyError(err), 'err'); }
  } }, h('label', {}, 'New password', pass), h('button', { class: 'primary', type: 'submit' }, 'Update password')), st.el);
}
