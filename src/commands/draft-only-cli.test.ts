// Draft-only mode through the real CLI: the marker file in the user's config
// directory turns it on, and a local server standing in for Slack records what
// reaches it. POSIX-only: Windows does not take its home from HOME.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FAKE_SLACK_ORIGIN, FAKE_SLACK_PRELOAD, FAKE_SLACK_SERVER_ENV } from '../test-support/fake-slack.ts';

const root = resolve(import.meta.dir, '../..');
const entry = join(root, 'src/index.ts');

describe.skipIf(process.platform === 'win32')('draft-only mode through the CLI', () => {
  let home: string;
  let server: ReturnType<typeof Bun.serve>;
  let methods: string[];

  beforeEach(async () => {
    methods = [];
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        methods.push(new URL(request.url).pathname.replace('/api/', ''));
        return Response.json({ ok: true, channel: 'C0123456789', ts: '1712345678.123456', draft: { id: 'Dr0123456789' } });
      },
    });

    home = await mkdtemp(join(tmpdir(), 'slackcli-draft-only-'));
    const configDir = join(home, '.config', 'slackcli');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configDir, 'workspaces.json'),
      JSON.stringify({
        default_workspace: 'T1',
        workspaces: {
          T1: {
            workspace_id: 'T1',
            workspace_name: 'acme',
            workspace_url: FAKE_SLACK_ORIGIN,
            auth_type: 'browser',
            xoxd_token: 'xoxd-fake',
            xoxc_token: 'xoxc-fake',
          },
        },
      }),
      { mode: 0o600 },
    );
    // The person who owns this profile has turned draft-only on.
    await writeFile(join(configDir, 'draft-only'), '');
  });

  afterEach(async () => {
    await server.stop(true);
    await rm(home, { recursive: true, force: true });
  });

  async function run(args: string[], env: Record<string, string> = {}) {
    const child = Bun.spawn([process.execPath, 'run', '--preload', FAKE_SLACK_PRELOAD, entry, 'messages', ...args, '--json'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        HOME: home,
        [FAKE_SLACK_SERVER_ENV]: `http://127.0.0.1:${server.port}`,
        SLACKCLI_LOG_LEVEL: 'off',
        SLACKCLI_NO_UPDATE_NOTIFIER: '1',
        SLACKCLI_WORKSPACE: '',
        SLACKCLI_TOKEN: '',
        SLACK_BOT_TOKEN: '',
        NO_COLOR: '1',
        ...env,
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  }

  it('drafts into a DM, which first opens the conversation', async () => {
    // A user ID has no channel until conversations.open returns one. Opening a
    // DM shows nothing to the other person, so draft-only must allow it.
    const drafted = await run(['draft', '--recipient-id', 'U0123456789', '--message', 'for review']);
    expect(drafted.code).toBe(0);
    expect(methods).toEqual(['conversations.open', 'drafts.create']);
  });

  it('drafts a reply but refuses to post one, even when the environment says otherwise', async () => {
    // Leaving a draft is the whole point, so it goes through.
    const drafted = await run(['draft', '--recipient-id', 'C0123456789', '--message', 'for review']);
    expect(drafted.code).toBe(0);
    expect(methods).toEqual(['drafts.create']);

    // Posting is refused before any request leaves the process, and a falsy
    // variable cannot override the marker file.
    const posted = await run(['send', '--recipient-id', 'C0123456789', '--message', 'oops'], { SLACKCLI_DRAFT_ONLY: '0' });
    expect(posted.code).toBe(1);
    const lines = posted.stderr.trimEnd().split('\n');
    expect(JSON.parse(lines[lines.length - 1]).error.code).toBe('permission_denied');
    expect(methods).toEqual(['drafts.create']);
  });
});
