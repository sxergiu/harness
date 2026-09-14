import React, { useEffect, useState } from 'react';
import type { SettingsView } from '@harness/shared';
import { useApi } from './useHarness.js';

/**
 * Everything about this INSTALL rather than this session: what agents are told,
 * which checkouts they may push from, and whether the files they depend on are
 * actually on the machine.
 *
 * One fetch fills all four panels and every write returns the whole view back,
 * so nothing here maintains its own idea of the state — the same discipline the
 * board follows for a much better reason, and the reason it costs nothing here
 * is that this screen is read rarely and never while anything is moving.
 */
export function Settings({ onClose }: { onClose: () => void }): React.ReactElement {
  const { get, post } = useApi();
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * What the last write actually did, when the view alone cannot say. Installing
   * the Herdr rule can correctly decline — upstream has it, there is no manifest
   * to merge into — and every one of those answers leaves the state untouched,
   * so without this the button looks broken.
   */
  const [note, setNote] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      setView(await get<SettingsView>('/api/settings'));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => { void load(); }, []);

  /** Every write answers with the new view, so there is nothing to refetch. */
  const write = async (path: string, body?: unknown): Promise<void> => {
    setError(null);
    setNote(null);
    try {
      const next = await post<SettingsView & { note?: string }>(path, body);
      setView(next);
      if (next.note) setNote(next.note);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col text-xs">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
        <span className="text-neutral-300">settings</span>
        <button onClick={onClose} className="ml-auto text-neutral-400 hover:text-neutral-200">
          close
        </button>
      </header>

      {error && <div className="bg-amber-900/30 px-3 py-1 text-amber-300">{error}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {view === null ? (
          <div className="text-neutral-600">Reading…</div>
        ) : (
          <>
            <Rules view={view} onSave={(text) => void write('/api/settings/rules', { text })} />
            <Checkouts
              view={view}
              onRevoke={(path) =>
                void write('/api/settings/checkouts', { path, gitDelegated: false })}
            />
            <ClaudeFiles
              view={view}
              onInstall={(force) => void write('/api/settings/claude-files', { force })}
            />
            <HerdrRule
              view={view}
              note={note}
              onInstall={(force) => void write('/api/settings/herdr', { force })}
            />
          </>
        )}
      </div>
    </div>
  );
}

function Section(
  { title, note, children }: { title: string; note?: string; children: React.ReactNode },
): React.ReactElement {
  return (
    <section className="mb-6">
      <h2 className="mb-1 text-neutral-500">{title}</h2>
      {note && <p className="mb-1.5 text-neutral-600">{note}</p>}
      {children}
    </section>
  );
}

/**
 * The whole system prompt, editable. It is `--append-system-prompt` and nothing
 * more, so the panel says so: every rule in here is an instruction an agent can
 * ignore without anything reporting that it did.
 */
function Rules(
  { view, onSave }: { view: SettingsView; onSave: (text: string) => void },
): React.ReactElement {
  const [text, setText] = useState(view.rules.text);
  // The server answers every write with the whole view, so this has to follow
  // it — otherwise a reset leaves the box holding what was just discarded.
  useEffect(() => setText(view.rules.text), [view.rules.text]);
  const dirty = text !== view.rules.text;

  return (
    <Section
      title="RULES"
      note="What every agent the cockpit starts is told. Injected with --append-system-prompt, so all of it is instruction: nothing here is enforced, and an agent that ignores a rule does so silently. Applies to agents started from now on."
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        className="h-72 w-full resize-y rounded border border-neutral-800 bg-neutral-950 p-2 font-mono text-neutral-300"
      />
      <div className="mt-1 flex items-center gap-3">
        <button
          disabled={!dirty}
          onClick={() => onSave(text)}
          className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-200 disabled:opacity-40"
        >
          save
        </button>
        {/* Empty IS the reset — the server drops the override rather than
            writing today's defaults into a file that would then freeze them. */}
        <button
          disabled={view.rules.isDefault && !dirty}
          onClick={() => onSave('')}
          className="text-neutral-400 hover:text-neutral-200 disabled:opacity-40"
        >
          reset to default
        </button>
        <span className="text-neutral-600">
          {view.rules.isDefault ? 'unchanged from what ships' : 'saved to ~/.harness/rules.md'}
        </span>
      </div>
    </Section>
  );
}

/**
 * The grant is on a path, so this is the only place one can be revoked after
 * the space that set it has gone — a workspace id does not outlive a Herdr
 * session, and this list does.
 */
function Checkouts(
  { view, onRevoke }: { view: SettingsView; onRevoke: (path: string) => void },
): React.ReactElement {
  return (
    <Section
      title="CHECKOUTS"
      note="Where agents may commit and push. Granted per checkout from ✎ on a space, so every space pointed at one shares it, and read when an agent starts — revoking changes nothing for agents already running."
    >
      {view.checkouts.length === 0 ? (
        <div className="text-neutral-600">
          Nothing delegated. Agents are told never to commit or push.
        </div>
      ) : (
        /*
          A list with a revoke, not a row of checkboxes: the store holds only
          the checkouts that ARE delegated — a revoke deletes the entry — so
          every box would be ticked and the only move available is off.
        */
        view.checkouts.map((c) => (
          <div key={c.path} className="group/co flex items-center gap-2 py-0.5">
            <span className="truncate font-mono text-neutral-400">{c.path}</span>
            <button
              onClick={() => onRevoke(c.path)}
              title="Agents started here are told never to commit or push again"
              className="ml-auto shrink-0 text-neutral-600 opacity-0 group-hover/co:opacity-100 hover:text-amber-400"
            >
              revoke
            </button>
          </div>
        ))
      )}
    </Section>
  );
}

/**
 * Rule 4 names a `planner` subagent and the board reads `/feature` and
 * `/investigate` back off transcripts — none of which exists unless these files
 * are on the machine. A missing one fails silently in exactly the way this
 * whole screen is here to make visible.
 */
function ClaudeFiles(
  { view, onInstall }: { view: SettingsView; onInstall: (force: boolean) => void },
): React.ReactElement {
  const differs = view.claudeFiles.some((f) => f.status === 'differs');
  const missing = view.claudeFiles.some((f) => f.status === 'missing');

  return (
    <Section
      title="CLAUDE FILES"
      note="The subagent and commands the cockpit depends on, in ~/.claude where Claude Code reads them."
    >
      {view.claudeFiles.map((f) => (
        <div key={f.name} className="flex items-baseline gap-2 py-0.5">
          <span className="w-44 shrink-0 truncate font-mono text-neutral-400" title={f.path}>
            {f.name}
          </span>
          <span className={f.status === 'ours' ? 'text-neutral-600' : 'text-amber-400'}>
            {STATUS[f.status]}
          </span>
        </div>
      ))}
      <div className="mt-1 flex items-center gap-3">
        {/* Only `missing` is what this button does. With nothing missing and a
            file of the human's own, it would decide `kept` for every one of
            them and change nothing — `replace mine` is that case's control. */}
        <button
          disabled={!missing}
          onClick={() => onInstall(false)}
          className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-200 disabled:opacity-40"
        >
          install missing
        </button>
        {differs && (
          <button onClick={() => onInstall(true)} className="text-amber-400 hover:text-amber-300">
            replace mine
          </button>
        )}
      </div>
    </Section>
  );
}

const STATUS: Record<SettingsView['claudeFiles'][number]['status'], string> = {
  ours: 'installed',
  missing: 'missing',
  differs: 'yours differs',
  unavailable: 'not in this build — run npm run build',
};

/**
 * Herdr misses the Claude in Chrome permission dialog, so an agent waiting on
 * one reads `idle` and never shows its blocked panel. The fix is a local
 * manifest, and its cost is stated rather than buried: a local file shadows
 * Herdr's own detection updates entirely, which is what `stale` is measuring.
 */
function HerdrRule(
  { view, note, onInstall }: {
    view: SettingsView;
    note: string | null;
    onInstall: (force: boolean) => void;
  },
): React.ReactElement {
  const { installed, ours, version, remoteVersion, stale } = view.herdr;

  return (
    <Section
      title="HERDR"
      note="Detection for the Claude in Chrome permission dialog, which Herdr's own rules do not match — without it an agent waiting on one reads as idle."
    >
      <div className="py-0.5 font-mono text-neutral-500" title={view.herdr.path}>
        {view.herdr.path}
      </div>
      {!installed ? (
        <div className="text-neutral-600">Not installed. Herdr's own manifest is in force.</div>
      ) : !ours ? (
        <div className="text-amber-400">
          An override is already there and we did not write it — it may carry rules of your own.
        </div>
      ) : (
        <div className={stale ? 'text-amber-400' : 'text-neutral-600'}>
          built from remote {version ?? '?'}
          {stale
            ? ` — Herdr's is now ${remoteVersion ?? '?'}, and this file is holding those updates back`
            : ' — current'}
        </div>
      )}
      <div className="mt-1 flex items-center gap-3">
        <button
          onClick={() => onInstall(false)}
          className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-200"
        >
          {installed && ours ? 'rebuild from current remote' : 'install'}
        </button>
        {installed && !ours && (
          <button onClick={() => onInstall(true)} className="text-amber-400 hover:text-amber-300">
            replace it
          </button>
        )}
      </div>
      {note && <div className="mt-1 text-neutral-400">{note}</div>}
    </Section>
  );
}
