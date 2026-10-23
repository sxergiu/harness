import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { trustFolder } from './claudeFiles.js';
import { asStatus, type Herdr } from './herdr.js';

/**
 * Waking agents stalled on API timeouts, the way the human found that works:
 * start a brand-new `claude`, send it "ping", and the stalled ones resume on
 * their own. Why it works is a GUESS — most likely the fresh process refreshes
 * the account's shared credentials, which the others re-read on their next
 * retry — and nothing here depends on the guess being right.
 *
 * Their recovery cannot be observed from here: a timeout is retried on screen
 * and written to no transcript (checked — every API error recorded on the
 * measuring machine was a session limit), so `errorOf` never sees one. The pane
 * is therefore closed once the ping itself is answered, a fresh session having
 * got through to the API being the moment the others can.
 *
 * The opposite of `usage.ts`'s choice to keep its agent warm: a fresh PROCESS is
 * the whole point, so a ping pane is never reused, and one a crashed harness
 * left behind is closed rather than adopted.
 */

/** The name our pinging agent goes by. Herdr's rule: [a-z][a-z0-9_-]{0,31}. */
export const PING_AGENT = 'harness-ping';

/**
 * How long the answer may take before the pane is closed regardless. Generous,
 * because the API this runs against is the one that has been timing out.
 */
const ANSWER_MS = 60_000;
const POLL_MS = 500;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Ping {
  private paneId: string | null = null;
  private inflight: Promise<void> | null = null;
  /**
   * Set by `close`. A shutdown inside `launchAgent`'s wait for the shell finds
   * no agent by name yet, so the launch has to notice it afterwards — or the
   * ping runs on for a minute and `app.close()` waits on its request.
   */
  private closed = false;

  constructor(private readonly herdr: Herdr) {}

  /** One ping at a time: a press while one is out waits on that one. */
  send(): Promise<void> {
    return (this.inflight ??= this.run().finally(() => {
      this.inflight = null;
    }));
  }

  private async run(): Promise<void> {
    const snap = await this.herdr.snapshot();
    const stray = (snap.agents ?? []).find((a) => a.name === PING_AGENT);
    if (stray) await this.herdr.closePane(stray.pane_id).catch(() => {});

    const workspace = snap.workspaces[0];
    if (!workspace) throw new Error('herdr has no space to open the ping agent in');

    // Our own directory for `usage.ts`'s reasons: nobody's repo, so its
    // transcript is filed among no project's agents, and the one folder whose
    // trust dialog we may answer — a ping stuck at that dialog wakes nobody.
    const cwd = join(homedir(), '.harness');
    mkdirSync(cwd, { recursive: true });
    trustFolder(cwd);

    const paneId = await this.herdr.launchAgent(
      PING_AGENT,
      { workspaceId: workspace.workspace_id, cwd, label: 'ping' },
      [],
    );
    if (this.closed) {
      await this.herdr.closePane(paneId).catch(() => {});
      return;
    }
    this.paneId = paneId;
    try {
      await this.answered(paneId);
    } finally {
      this.paneId = null;
      await this.herdr.closePane(paneId).catch(() => {});
    }
  }

  /**
   * Waits for the ping's turn to complete.
   *
   * `completion_seq` moves once per finished turn, independently of whether
   * anyone has viewed the pane — which `done` does not survive, the cockpit
   * focusing panes as it goes. `agent.wait --until idle` is no substitute: it
   * matches the CURRENT state, so asked straight after the prompt it answers
   * before the agent has even started working. Working-then-settled is the
   * fallback for a Herdr that does not report the counter, and it is blind to a
   * turn shorter than one poll — that ping is answered and reported as not.
   */
  private async answered(paneId: string): Promise<void> {
    const before = (await this.herdr.agentInfo(PING_AGENT))?.completion_seq ?? null;
    await this.herdr.prompt(paneId, 'ping');

    let sawWorking = false;
    for (const deadline = Date.now() + ANSWER_MS; Date.now() < deadline; ) {
      await delay(POLL_MS);
      const info = await this.herdr.agentInfo(PING_AGENT);
      if (!info) throw new Error('the ping agent exited before answering');
      const seq = info.completion_seq ?? null;
      if (seq !== null && seq !== before) return;
      const status = asStatus(info.agent_status);
      // Nobody will ever answer a dialog in a pane nobody can see.
      if (status === 'blocked') throw new Error('the ping agent stopped at a dialog');
      if (status === 'working') sawWorking = true;
      else if (sawWorking && (status === 'idle' || status === 'done')) return;
    }
    throw new Error(`the ping was not answered within ${ANSWER_MS / 1000}s — closed it anyway`);
  }

  /**
   * Ends an in-flight ping with the cockpit, as `Usage.close` does. The name
   * lookup covers a shutdown that lands mid-launch, before `paneId` is known.
   */
  async close(): Promise<void> {
    this.closed = true;
    const paneId = this.paneId ?? (await this.herdr.agentInfo(PING_AGENT))?.pane_id;
    this.paneId = null;
    if (paneId) await this.herdr.closePane(paneId);
  }
}
