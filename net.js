// Thin PeerJS wrapper (global `Peer` from the CDN script). The host's peer id is the room code; guests connect
// to it directly over WebRTC, using PeerJS's free public broker only to find each other.
const PREFIX = 'graveshift-v1-';

export function hostRoom() {
  return new Promise((resolve, reject) => {
    const code = Math.random().toString(36).slice(2, 7);
    const peer = new Peer(PREFIX + code);
    peer.on('open', () => resolve({ peer, code }));
    peer.on('error', e => {
      if (e.type !== 'unavailable-id') return reject(e);
      peer.destroy();
      hostRoom().then(resolve, reject);
    });
  });
}

export function joinRoom(code) {
  return new Promise((resolve, reject) => {
    const peer = new Peer();
    const timer = setTimeout(() => reject(new Error('Timed out reaching the host')), 15000);
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code.trim().toLowerCase(), { reliable: true, serialization: 'json' });
      conn.on('open', () => { clearTimeout(timer); resolve({ peer, conn }); });
    });
    peer.on('error', e => {
      clearTimeout(timer);
      reject(e.type === 'peer-unavailable' ? new Error('Room not found. Check the code or ask for a fresh invite.') : e);
    });
  });
}
