import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAuthorizeUrl, lettaOAuthClientId } from '../src/main/libs/letta-oauth.ts';
import { checkForUpdatesNow, installUpdate, updateReady } from '../src/main/libs/updater.ts';

test('sign-in requires a builder client and uses an independent callback', () => {
  assert.throws(() => lettaOAuthClientId({}), /Configure/);
  const clientId = lettaOAuthClientId({ HEARTHSIDE_SOURCE_LETTA_OAUTH_CLIENT_ID: 'sample-client' });
  const url = new URL(buildAuthorizeUrl({ clientId, state: 'synthetic-state', challenge: 'synthetic-challenge' }));
  assert.equal(url.searchParams.get('client_id'), 'sample-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'hearthside-source://oauth/callback');
});

test('update methods cannot contact a publisher or stop the runtime', async () => {
  assert.equal((await checkForUpdatesNow()).status, 'error');
  assert.equal(updateReady(), null);
  let stopped = false;
  await assert.rejects(installUpdate(async () => { stopped = true; }), /disabled/);
  assert.equal(stopped, false);
});

test('default build does not prepare or publish a release', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(manifest.scripts.build, 'electron-vite build');
  assert.equal(manifest.private, true);
  assert.ok(!('electron-updater' in manifest.dependencies));
});
