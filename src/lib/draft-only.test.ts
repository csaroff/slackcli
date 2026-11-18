import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDraftOnlyAllows, isDraftOnly } from './draft-only.ts';
import { SlackClient } from './slack-client.ts';
import { CliError } from './cli-errors.ts';

const BROWSER = {
  workspace_id: 'T123',
  workspace_name: 'Test Workspace',
  auth_type: 'browser' as const,
  xoxd_token: 'xoxd-test',
  xoxc_token: 'xoxc-test',
  workspace_url: 'https://example.slack.com',
};

describe('draft-only mode', () => {
  let dir: string;
  let marker: string;
  const savedEnv = process.env.SLACKCLI_DRAFT_ONLY;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slackcli-draft-only-'));
    marker = join(dir, 'draft-only');
    delete process.env.SLACKCLI_DRAFT_ONLY;
  });

  afterEach(async () => {
    globalThis.fetch = savedFetch;
    if (savedEnv === undefined) delete process.env.SLACKCLI_DRAFT_ONLY;
    else process.env.SLACKCLI_DRAFT_ONLY = savedEnv;
    await rm(dir, { recursive: true, force: true });
  });

  it('lets an agent read and draft, but refuses anything a human would see before review', async () => {
    // An assistant prepares replies on someone's behalf. The person turns on
    // draft-only so that nothing the assistant does can reach a channel.

    // Every call that reaches the transport is recorded; a refused call must
    // never get there.
    const sent: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      sent.push(String(input).split('/api/')[1] ?? String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client = new SlackClient(BROWSER, {
      draftOnly: true,
      rateLimiter: { run: (fn: () => Promise<unknown>) => fn() } as any,
    });

    // Reading the thread and leaving a draft with a private screenshot work.
    await client.request('conversations.replies', { channel: 'C1', ts: '1.0' });
    await client.request('drafts.list', {});
    await client.request('files.completeUploadExternal', { files: '[{"id":"F1"}]' });
    await client.request('drafts.create', { destinations: '[]' });
    expect(sent).toEqual(['conversations.replies', 'drafts.list', 'files.completeUploadExternal', 'drafts.create']);

    // Posting, editing, reacting, and sending or deleting a draft are refused
    // before any request is built, with a code a script can react to.
    for (const method of ['chat.postMessage', 'chat.update', 'reactions.add', 'drafts.delete', 'chat.scheduleMessage']) {
      const error = await client.request(method, {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe('permission_denied');
      expect((error as Error).message).toContain(method);
    }

    // A file upload that would share into a channel is refused too.
    await expect(client.request('files.completeUploadExternal', { files: '[]', channel_id: 'C1' }))
      .rejects.toThrow(/shares files/);
    expect(sent).toHaveLength(4);
  });

  it.each([
    ['the environment variable', { env: '1', marker: false }, true],
    ['the marker file', { env: undefined, marker: true }, true],
    ['neither', { env: undefined, marker: false }, false],
    ['a falsy variable alone', { env: '0', marker: false }, false],
    ['a falsy variable with the marker file (cannot switch it off)', { env: '0', marker: true }, true],
  ])('is on with %s', async (_label, setup, expected) => {
    if (setup.marker) await Bun.write(marker, '');
    const env = setup.env === undefined ? {} : { SLACKCLI_DRAFT_ONLY: setup.env };
    expect(isDraftOnly(env, marker)).toBe(expected);
  });

  it.each([
    ['files.completeUploadExternal', { thread_ts: '1.0' }],
    ['files.completeUploadExternal', { initial_comment: 'hi' }],
    ['files.completeUploadExternal', { channels: 'C1' }],
    ['conversations.mark', {}],
    ['usergroups.update', {}],
  ])('refuses %s with %j', (method, params) => {
    expect(() => assertDraftOnlyAllows(method, params)).toThrow(CliError);
  });
});
