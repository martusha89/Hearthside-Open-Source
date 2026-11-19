# Hearthside Source Edition

This local development edition starts from selected Hearthside sources at `936f56653c568497a0371ca3f26981f08d19c66f`. It is not an official Windows download, an installer, or a replacement profile for an installed copy. For the supported Windows distribution, use the project's official download channel separately.

Source builds are maintained by their builder. They must not subscribe to the official updater or publish to the official channel. To update, pull reviewed changes from the source-edition repository (`martusha89/Hearthside-Open-Source`) and rebuild locally. Use a fresh source-edition profile; do not point a source build at your installed app's data. Optional GIF search is off by default. For a private build, set `MAIN_VITE_SOURCE_KLIPY_API_KEY` to your own KLIPY key before building. Treat build-time values as visible in the resulting bundle. Do not add keys to source control or distribute a build containing a private key.

## Working with the source

Use Node.js 24 LTS (24.22.1 or later in the 24.x line). From the repository root:

```sh
npm ci --no-audit
npm run typecheck
npm test
npm run build
```

The renderer uses React 19.3.0. A scoped npm override preserves the shipped React 18.3.1 inside Letta Code 0.34.36: its manifest requests 18.2.0, but its nested reconciler requires `^18.3.1`. Do not flatten the two React versions. Depending on the npm version, `npm ls react --all` may still flag the runtime's raw 18.2.0 declaration; this is distinct from a failed clean install or build.

The build targets the desktop application, not a signed Windows installer. A successful bundle is not a test of the local agent runtime or a live provider. A separate app profile does not isolate host credentials: provider helpers can discover existing sign-ins, and runtime processes can inherit shell variables. For live testing, use a clean OS account and synthetic data, not a production profile. The source tests exercise a fabricated import without launching Electron. “Letta” identifies compatibility and is a trademark of its owner.

## Connect a private test bot (optional)

The install, checks and build above do not need bot tokens. From the same repository root, `npm run prepare-runtime --workspace apps/desktop` prepares the agent runtime and installs both channel libraries from their dedicated lockfiles (requires access to the npm registry or a populated cache). No global bot SDKs are needed. After preparation, run `node apps/desktop/scripts/smoke-channel-resolver.mjs` to verify that the prepared runtime can load both adapters offline. This check does not start a gateway, pair an account, or prove live delivery. `npm run build` compiles the desktop app; it does not prepare those runtimes. Start the source app with `npm run dev`, or after building use `npm run preview --workspace apps/desktop`. Both launch commands run runtime preparation automatically. Set up a test agent with a working model provider and verify it answers in the desktop chat first. Open **Channels** for that agent. Use a newly created bot per service; do not reuse a token already connected to another profile or gateway.

- **Telegram:** Open the verified `@BotFather` account in Telegram, send `/newbot`, and choose a name and bot username. Paste the issued token into the Telegram bot form in Hearthside. For a DM-only test leave group privacy enabled, do not add the bot to groups, and grant no administrator privileges.
- **Discord:** Create a test application at [Discord Developer Portal](https://discord.com/developers/applications). On **Bot**, enable **Message Content Intent** and generate/reset the bot token (not the application ID or client secret). Paste the token into Hearthside's Discord bot form. Under **OAuth2 → URL Generator**, select the `bot` scope. Invite it to a private test server you manage; restrict **View Channel**, **Send Messages**, and **Read Message History** to the intended room. Do not grant **Administrator**. Only grant **Add Reactions** or **Send Messages in Threads** if testing those features. For DM-only testing, turn off ambient bot participation and explicit bot mentions in Hearthside as well.

Select **Just me (recommended)** before connecting. In a private DM to the bot, send a test greeting (on Telegram, press **Start** first). In Channels, match the requester, bot, agent and code with your own DM before approving. With Just me, this first approved DM identifies the sole permitted DM sender. Send another DM and check for the reply in the same conversation. Use **People I approve** only if each additional sender should pair separately; decline unknown requests. **Anyone** bypasses DM approval. These settings do not make groups or Discord servers private: pairing is requested in DMs, not rooms, and room access/listening must be restricted separately.

If a DM produces no request, verify the agent and bot selected, the channel service status, and that no other app is using the token. For Discord also check server DM settings, effective room permissions and Message Content Intent. Do not broaden access to **Anyone** or **Administrator** to troubleshoot. Never paste tokens into chats, issue reports, screenshots or source files. If exposed, revoke/regenerate the token at the provider and replace the saved bot credential. Remove the test bot when finished.

Continuity Studio, the companion prompt, and the Memory View were designed by Marta S and Cassian Varen for AI·DHD.

See [PROVENANCE.md](PROVENANCE.md) for file-level scope and open questions. The included LICENSE, NOTICE, individual file notices, and applicable dependency licenses remain intact. The designers would like a future no-sale policy for eligible original contributions, subject to confirming rights and scope. That intent is not a license condition, does not amend existing grants, and imposes no restriction on upstream code. Cursor integration does not confer rights to redistribute Cursor, its credentials, or its services. Provider names and marks identify their respective services; their own terms apply.
