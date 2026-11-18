// Draft-only mode: a guard for assistants and scripts that prepare messages
// for a human. When it is on, SlackClient.request() refuses every Slack call
// that is not a read, a draft, or a private file upload, so nothing reaches a
// channel until a person sends the draft from Slack.
//
// It is on when SLACKCLI_DRAFT_ONLY is truthy, or when the marker file
// ~/.config/slackcli/draft-only exists. The marker cannot be switched off from
// the environment, so a caller that only controls env vars cannot lift it.
//
// This guards against mistakes, not against a hostile caller: anyone who can
// delete the marker file or read the stored tokens can still post.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from './cli-errors.ts';
import { isReadMethod } from './retry.ts';

export const DRAFT_ONLY_ENV = 'SLACKCLI_DRAFT_ONLY';
export const DRAFT_ONLY_MARKER = join(homedir(), '.config', 'slackcli', 'draft-only');

// Writes that leave nothing visible to anyone else. conversations.open finds
// or opens the DM a draft to a user ID goes into; the other person sees
// nothing until a message is sent.
const DRAFT_WRITES: ReadonlySet<string> = new Set([
  'conversations.open',
  'drafts.create',
  'files.getUploadURLExternal',
  'files.completeUploadExternal',
]);

// files.completeUploadExternal shares the files when given any of these.
const SHARE_PARAMS = ['channel_id', 'channels', 'thread_ts', 'initial_comment'] as const;

function truthy(value: string | undefined): boolean {
  return !!value && !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

export function isDraftOnly(
  env: Record<string, string | undefined> = process.env,
  marker: string = DRAFT_ONLY_MARKER,
): boolean {
  return truthy(env[DRAFT_ONLY_ENV]) || existsSync(marker);
}

export function assertDraftOnlyAllows(method: string, params: Record<string, unknown>): void {
  if (isReadMethod(method)) return;

  if (!DRAFT_WRITES.has(method)) {
    throw new CliError(
      'permission_denied',
      `Draft-only mode refuses ${method}: only reads, drafts and private uploads are allowed`,
      `Create a draft with "slackcli messages draft" for a human to send. Draft-only is on via ${DRAFT_ONLY_ENV} or ${DRAFT_ONLY_MARKER}.`,
    );
  }

  if (method === 'files.completeUploadExternal' && SHARE_PARAMS.some((key) => params[key] !== undefined)) {
    throw new CliError(
      'permission_denied',
      'Draft-only mode refuses an upload that shares files into a conversation',
      'Attach files to a draft with "slackcli messages draft --file".',
    );
  }
}
