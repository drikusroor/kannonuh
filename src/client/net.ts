import type { ClientMsg, ServerMsg } from '../shared/types.ts';

/** Discord serves the activity from `/.proxy/…`; keep every request under it. */
export function basePath(): string {
  const p = location.pathname;
  const i = p.indexOf('/.proxy');
  return i >= 0 ? p.slice(0, i + 7) : '';
}

export function socketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${basePath()}/ws`;
}

type Handler = (msg: ServerMsg) => void;

export class Net {
  private ws: WebSocket | null = null;
  private queue: ClientMsg[] = [];
  private retry = 0;
  private closed = false;
  private handler: Handler;
  private onStatus: (up: boolean) => void;
  /** Replayed on every (re)connect so a dropped socket resumes the battle. */
  hello: ClientMsg | null = null;

  constructor(handler: Handler, onStatus: (up: boolean) => void) {
    this.handler = handler;
    this.onStatus = onStatus;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closed = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(socketUrl());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.onStatus(true);
      if (this.hello) ws.send(JSON.stringify(this.hello));
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      this.handler(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      this.onStatus(false);
      if (!this.closed) this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleRetry(): void {
    this.retry = Math.min(this.retry + 1, 6);
    setTimeout(() => this.connect(), 400 * Math.pow(1.7, this.retry));
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      if (this.queue.length < 40) this.queue.push(msg);
      this.connect();
    }
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
