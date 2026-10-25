// WebSocket bridge: a WebSocket door onto the existing TCP libp2p listener.
// Bun's own WebSocket server copies bytes between each accepted socket and a
// TCP connection to the service's own listener. Noise runs end to end, so the
// bridge sees ciphertext only.
declare const Bun: any;

export interface WsBridgeOptions {
  /** Port to listen on for WebSocket clients. 0 picks a free port. */
  port: number;
  /** TCP port of the service's own libp2p listener (127.0.0.1). */
  tcpPort: number;
  /** Allowed Origin header values. Empty list allows none with an Origin. */
  origins: string[];
}

export interface WsBridge {
  port: number;
  stop(): Promise<void>;
}

export async function startWsBridge(opts: WsBridgeOptions): Promise<WsBridge> {
  const origins = opts.origins ?? [];
  const tcpPort = opts.tcpPort;
  const sockets = new Set<any>();
  const websockets = new Set<any>();
  // A socket write may accept only part of a chunk. Keep the rest and send it
  // on drain: a dropped byte would corrupt the Noise stream.
  const flush = (ws: any) => {
    const sock = ws.data.tcp;
    const queue = ws.data.early as Uint8Array[];
    while (sock && queue.length) {
      const wrote = sock.write(queue[0]);
      if (wrote < queue[0].length) { queue[0] = queue[0].subarray(Math.max(wrote, 0)); return; }
      queue.shift();
    }
  };

  const server = Bun.serve({
    port: opts.port,
    hostname: '127.0.0.1',
    fetch(req: Request, srv: any) {
      const origin = req.headers.get('origin');
      if (origin !== null && !origins.includes(origin)) {
        return new Response('forbidden origin', { status: 403 });
      }
      const ok = srv.upgrade(req, { data: { tcp: undefined, early: [] as Uint8Array[] } });
      if (!ok) {
        return new Response('websocket only', { status: 426 });
      }
      return undefined;
    },
    websocket: {
      async open(ws: any) {
        ws.binaryType = 'uint8array';
        websockets.add(ws);
        try {
          const sock = await Bun.connect({
            hostname: '127.0.0.1',
            port: tcpPort,
            socket: {
              drain() {
                try { flush(ws); } catch { /* socket closed */ }
              },
              data(_s: any, d: Uint8Array) {
                try {
                  ws.sendBinary(d);
                } catch {
                  /* peer went away */
                }
              },
              close() {
                try {
                  ws.close();
                } catch {
                  /* already closed */
                }
              },
              error() {
                try {
                  ws.close();
                } catch {
                  /* already closed */
                }
              },
            },
          });
          // If the websocket closed while TCP was connecting, drop the socket.
          if (!websockets.has(ws)) {
            try {
              sock.end();
            } catch {
              /* ignore */
            }
            return;
          }
          ws.data.tcp = sock;
          sockets.add(sock);
          try { flush(ws); } catch { /* socket closed */ }
        } catch {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
      },
      message(ws: any, m: any) {
        if (typeof m === 'string') return; // binary frames only
        const d = m as Uint8Array;
        (ws.data.early as Uint8Array[]).push(d);
        try { flush(ws); } catch { /* socket closed */ }
      },
      close(ws: any) {
        websockets.delete(ws);
        const sock = ws.data?.tcp;
        if (sock) {
          sockets.delete(sock);
          try {
            sock.end();
          } catch {
            /* ignore */
          }
          ws.data.tcp = undefined;
        } else {
          ws.data.early = [];
        }
      },
    },
  });

  const realPort = server.port as number;
  const stop = async (): Promise<void> => {
    for (const ws of [...websockets]) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    websockets.clear();
    for (const sock of [...sockets]) {
      try {
        sock.end();
      } catch {
        /* ignore */
      }
    }
    sockets.clear();
    server.stop(true);
  };
  return { port: realPort, stop };
}
