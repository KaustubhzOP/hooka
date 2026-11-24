/**
 * Peer-to-peer video/audio between up to 5 players (a full mesh: every
 * player connects to every other). Signalling (offers, answers, ICE
 * candidates) travels over the room's private Supabase Realtime channel.
 * Uses the "perfect negotiation" pattern so simultaneous offers don't clash.
 * Media goes directly between browsers (or through a TURN relay, if one is
 * configured) and is never stored.
 */

export type Signal =
  | { kind: 'description'; from: string; to: string; description: RTCSessionDescriptionInit }
  | { kind: 'candidate'; from: string; to: string; candidate: RTCIceCandidateInit | null }
  | { kind: 'bye'; from: string; to: string };

/** Free public STUN servers, plus an optional TURN relay from the env (needed behind strict NATs / mobile data). */
export function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  const urls = (import.meta.env.VITE_TURN_URLS as string | undefined)?.split(',').map(s => s.trim()).filter(Boolean);
  if (urls?.length) servers.push({ urls, username: import.meta.env.VITE_TURN_USERNAME, credential: import.meta.env.VITE_TURN_CREDENTIAL });
  return servers;
}

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  stream: MediaStream;
}

export class Mesh {
  private peers = new Map<string, Peer>();
  /** Called when a peer's media arrives or changes; null when the peer is gone. */
  onStream: (peerId: string, stream: MediaStream | null) => void = () => {};
  onState: (peerId: string, state: RTCPeerConnectionState) => void = () => {};

  constructor(private self: string, private send: (s: Signal) => void, private local: MediaStream) {}

  get peerIds(): string[] { return [...this.peers.keys()]; }

  /** Make sure we're connected to exactly these peers. */
  sync(peerIds: string[]): void {
    for (const id of peerIds) if (id !== this.self && !this.peers.has(id)) this.connect(id);
    for (const id of [...this.peers.keys()]) if (!peerIds.includes(id)) this.drop(id);
  }

  /** Swap the outgoing video/audio (e.g. after re-creating the canvas stream). */
  replaceLocal(stream: MediaStream): void {
    this.local = stream;
    for (const p of this.peers.values()) {
      for (const sender of p.pc.getSenders()) {
        const t = stream.getTracks().find(x => x.kind === sender.track?.kind);
        if (t) void sender.replaceTrack(t);
      }
    }
  }

  async handle(s: Signal): Promise<void> {
    if (s.to !== this.self || s.from === this.self) return;
    if (s.kind === 'bye') { this.drop(s.from); return; }
    const p = this.peers.get(s.from) ?? this.connect(s.from);
    const pc = p.pc;
    try {
      if (s.kind === 'description') {
        const d = s.description;
        const collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          await pc.setLocalDescription();
          this.send({ kind: 'description', from: this.self, to: s.from, description: pc.localDescription!.toJSON() });
        }
      } else {
        try { await pc.addIceCandidate(s.candidate ?? undefined); }
        catch (e) { if (!p.ignoreOffer) throw e; }
      }
    } catch (e) {
      console.warn('rtc signal failed', e);
    }
  }

  close(): void {
    for (const id of [...this.peers.keys()]) {
      this.send({ kind: 'bye', from: this.self, to: id });
      this.drop(id);
    }
  }

  private connect(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const p: Peer = { pc, polite: this.self > id, makingOffer: false, ignoreOffer: false, stream: new MediaStream() };
    this.peers.set(id, p);
    for (const t of this.local.getTracks()) pc.addTrack(t, this.local);

    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ kind: 'description', from: this.self, to: id, description: pc.localDescription!.toJSON() });
      } catch (e) { console.warn('rtc offer failed', e); }
      finally { p.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => this.send({ kind: 'candidate', from: this.self, to: id, candidate: candidate?.toJSON() ?? null });
    pc.ontrack = ({ track, streams }) => {
      const src = streams[0];
      if (src) p.stream = src;
      else if (!p.stream.getTracks().includes(track)) p.stream.addTrack(track);
      this.onStream(id, p.stream);
    };
    pc.onconnectionstatechange = () => {
      this.onState(id, pc.connectionState);
      if (pc.connectionState === 'failed') pc.restartIce();
    };
    return p;
  }

  private drop(id: string): void {
    const p = this.peers.get(id);
    if (!p) return;
    p.pc.close();
    this.peers.delete(id);
    this.onStream(id, null);
  }
}
