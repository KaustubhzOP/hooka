/**
 * Who is signed in (Supabase Auth session = JWT) and their profile.
 * Guests can play solo; leaderboard saving, friends and online rooms need an account + username.
 */
import type { Session } from '@supabase/supabase-js';
import { auth, api, backendEnabled, type Profile } from '../backend/supabase';

type Listener = (a: AccountStore, event?: string) => void;

export class AccountStore {
  session: Session | null = null;
  profile: Profile | null = null;
  ready = false;
  private listeners: Listener[] = [];
  private presenceTimer = 0;

  get enabled() { return backendEnabled; }
  get signedIn() { return !!this.session; }
  get uid(): string | null { return this.session?.user.id ?? null; }
  get email(): string | null { return this.session?.user.email ?? null; }
  /** Signed in but hasn't picked a username yet. */
  get needsUsername() { return this.signedIn && this.ready && !this.profile; }
  get canPlayOnline() { return this.signedIn && !!this.profile; }

  on(fn: Listener) { this.listeners.push(fn); }
  private emit(event?: string) { for (const l of this.listeners) l(this, event); }

  async init(): Promise<void> {
    if (!backendEnabled) { this.ready = true; this.emit(); return; }
    auth.onChange((event, session) => {
      this.session = session;
      if (event === 'PASSWORD_RECOVERY') this.emit('recovery');
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED' || event === 'INITIAL_SESSION') void this.loadProfile(event);
    });
    this.session = await auth.session();
    await this.loadProfile('init');
  }

  async loadProfile(event?: string): Promise<void> {
    const uid = this.uid;
    try { this.profile = uid ? await api.myProfile(uid) : null; }
    catch (e) { console.warn('profile load failed', e); }
    this.ready = true;
    clearInterval(this.presenceTimer);
    if (this.profile) {
      void api.touch().catch(() => {});
      this.presenceTimer = window.setInterval(() => void api.touch().catch(() => {}), 60_000);
    }
    this.emit(event);
  }

  setProfile(p: Profile) { this.profile = p; this.emit('profile'); }

  async signOut() {
    await auth.signOut();
    this.session = null; this.profile = null;
    clearInterval(this.presenceTimer);
    this.emit('SIGNED_OUT');
  }
}
