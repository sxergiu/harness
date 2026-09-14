import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentRow, ServerEvent, WorkspaceRow } from '@harness/shared';

export interface HarnessState {
  workspaces: WorkspaceRow[];
  agents: AgentRow[];
  recent: AgentRow[];
  /** Whether the Herdr socket is up — distinct from our own WS being up. */
  herdrConnected: boolean;
  herdrError: string | null;
  /** A live board with something to disclose, where `herdrError` is a dead one. */
  herdrWarning: string | null;
  connected: boolean;
  /** The harness was quit on purpose, so a dropped socket is the end and not a blip. */
  quit: boolean;
}

const EMPTY: HarnessState = {
  workspaces: [], agents: [], recent: [],
  herdrConnected: false, herdrError: null, herdrWarning: null, connected: false,
  quit: false,
};

/**
 * Single WS subscription. Every mutation goes over HTTP and comes back as a
 * broadcast, so there is one source of truth and no optimistic-update drift.
 */
export function useHarness(): HarnessState & { tick: number } {
  const [state, setState] = useState<HarnessState>(EMPTY);
  const [tick, setTick] = useState(0);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    /** Held here as well as in state, because `onclose` is what has to read it. */
    let quit = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = (): void => {
      const sock = new WebSocket(`ws://${location.host}/ws`);
      ws.current = sock;

      sock.onopen = () => setState((s) => ({ ...s, connected: true }));

      // State is deliberately NOT cleared: the board dims and keeps showing the
      // last thing it knew rather than going blank.
      sock.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!closed && !quit) retry = setTimeout(connect, 1000);
      };

      sock.onmessage = (ev) => {
        const e = JSON.parse(ev.data as string) as ServerEvent;
        if (e.type === 'quit') {
          quit = true;
          // The tab closes ITSELF, because nothing else can: `openBrowser`
          // shells out to `open` and keeps no handle on what it opened, so the
          // server has nothing to address. A top-level tab is script-closable
          // while its session history holds one entry — which this one always
          // does, since the cockpit is a single view that never navigates — and
          // Chrome honours it on a tab `open` created. Measured, not assumed.
          //
          // Deliberately hung on `quit` and never on `onclose`: `tsx watch`
          // restarts the dev server with SIGTERM on every save, and `shutdown`
          // stays silent on a signal for exactly this reason. Only a decision to
          // end the cockpit — the ⏻ here, or `harness stop` — says so out loud.
          //
          // A refusal is not an error and needs no branch: a tab someone opened
          // by hand onto a URL they had already been somewhere else from keeps
          // its history, stays put, and falls through to the banner below, which
          // is the behaviour this replaces rather than a degraded one.
          window.close();
        }
        setState((s) => reduce(s, e));
        if (e.type === 'agents' || e.type === 'hello') setTick((n) => n + 1);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws.current?.close();
    };
  }, []);

  // The count of agents wanting attention, where a background tab can see it.
  useEffect(() => {
    const n = state.agents.filter(wantsAttention).length;
    document.title = n > 0 ? `(${n}) harness` : 'harness';
    setFavicon(n);
  }, [state.agents]);

  return { ...state, tick };
}

/**
 * Whether a row is asking for you. A stalled agent counts: an API error leaves
 * it `idle`, so nothing about its status would otherwise distinguish "finished"
 * from "died an hour ago". One definition, because the tab title, the favicon
 * and the collapsed-space badge must agree on the number they show.
 */
export const wantsAttention = (a: AgentRow): boolean =>
  a.status === 'blocked' || a.status === 'done' || Boolean(a.error);

function reduce(s: HarnessState, e: ServerEvent): HarnessState {
  switch (e.type) {
    case 'hello':
      // `herdrWarning` is preserved: hello says nothing about it, and a
      // reconnect that cleared it would drop the disclosure silently.
      return {
        workspaces: e.workspaces, agents: e.agents, recent: e.recent,
        herdrConnected: e.herdrConnected, herdrError: null,
        herdrWarning: s.herdrWarning, connected: true, quit: false,
      };
    case 'agents':
      return { ...s, agents: e.agents, workspaces: e.workspaces };
    case 'recent':
      return { ...s, recent: e.recent };
    case 'herdr':
      return {
        ...s,
        herdrConnected: e.connected,
        herdrError: e.error ?? null,
        herdrWarning: e.warning ?? null,
      };
    case 'quit':
      return { ...s, quit: true };
    default:
      return s;
  }
}

function setFavicon(n: number): void {
  const color = n > 0 ? '%23f59e0b' : '%2364748b';
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>` +
    `<circle cx='8' cy='8' r='7' fill='${color}'/></svg>`;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = `data:image/svg+xml,${svg}`;
}

export function useApi(): {
  post: <T>(path: string, body?: unknown) => Promise<T>;
  get: <T>(path: string) => Promise<T>;
} {
  const post = useCallback(async <T,>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return res.json() as Promise<T>;
  }, []);
  const get = useCallback(async <T,>(path: string): Promise<T> => {
    const res = await fetch(path);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return res.json() as Promise<T>;
  }, []);
  return { post, get };
}

/** "12m" / "3h" — time in the current state, which is what the board reports. */
export function since(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
