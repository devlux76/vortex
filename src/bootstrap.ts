import type { Transport } from './types.ts';

export type BootstrapTransport = Pick<Transport, 'dial' | 'onPeer'>;

const initialDelayMs = 100;
const maxDelayMs = 5000;

// The peer id at the end of a configured multiaddr, when the owner gave one.
const peerOfAddr = (addr: string): string | undefined => {
  const at = addr.lastIndexOf('/p2p/');
  if (at < 0) return undefined;
  const tail = addr.slice(at + 5);
  return tail.length > 0 ? tail : undefined;
};

/**
 * Keep one configured bootstrap peer dialed: dial on startup, retry failures
 * with bounded exponential backoff, and redial after it disconnects (TODO I2).
 * Attempts never overlap and at most one retry timer exists. The returned
 * stop clears the timer, detaches the listener, and late attempts schedule
 * nothing further. Disconnects from any other peer are ignored.
 */
export function connectBootstrap(transport: BootstrapTransport, addr: string, onError: (message: string) => void): () => void {
  let stopped = false;
  let knownPeer: string | undefined = peerOfAddr(addr);
  let delayMs = initialDelayMs;
  let inFlight = false;
  let redialPending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = (fn: () => void, ms: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; if (!stopped) fn(); }, ms);
  };
  const schedule = (): void => {
    if (stopped || inFlight || timer !== undefined) return;
    const wait = delayMs;
    delayMs = Math.min(delayMs * 2, maxDelayMs);
    later(() => { void attempt(); }, wait);
  };
  const attempt = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    redialPending = false;
    try {
      knownPeer = await transport.dial(addr);
    } catch {
      inFlight = false;
      if (stopped) return;
      onError(`bootstrap dial failed; retrying (${delayMs}ms backoff)`);
      schedule();
      return;
    }
    inFlight = false;
    if (stopped) return;
    delayMs = initialDelayMs;
    // A disconnect that arrived mid-dial still needs its redial.
    if (redialPending) {
      redialPending = false;
      schedule();
    }
  };
  const detach = transport.onPeer(event => {
    if (stopped || event.kind !== 'disconnect' || event.peer !== knownPeer) return;
    if (inFlight) redialPending = true;
    else schedule();
  });
  void attempt();
  return () => {
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    detach();
  };
}
