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

## Connect your companion to Telegram or Discord

Open your companion in Hearthside and choose **Channels**. You can connect Telegram, Discord, or both. Use a bot you already own, or create one if you don’t have one yet. If another app or Hearthside profile is already running that bot, disconnect it there first. You can keep using the same bot after setup.

- **Telegram:** Enter your bot token in the Telegram form. To create a bot, open the verified **@BotFather** account in Telegram and send `/newbot`. For private conversations, you don’t need to add the bot to a group or give it administrator privileges.
- **Discord:** Open your application in the [Discord Developer Portal](https://discord.com/developers/applications), or create one. Under **Bot**, enable **Message Content Intent** and enter the bot token in Hearthside (not the application ID or client secret). To invite the bot to your server, select the `bot` scope in **OAuth2 → URL Generator**. Grant **View Channel**, **Send Messages**, and **Read Message History** only where you want it to participate. Add thread or reaction permissions only if you use those features; **Administrator** isn’t needed.

For one-to-one conversations, choose **Just me** before connecting. Open a DM with your bot (on Telegram, press **Start**) and say hello. In **Channels**, match the pairing request to your own account, bot, companion, and code before approving it. You can then chat with your companion there. Choose **People I approve** if you want to pair additional people individually. DM pairing doesn’t restrict who can see a group or server channel; configure those permissions separately.

If no pairing request appears, check that the channel is connected and nothing else is running the same token. On Discord, also check server DM settings, channel permissions, and Message Content Intent. Keep tokens out of chat, screenshots, issues, and source files. If a token is exposed, regenerate it with the provider and update it in Hearthside.

**For source builders:** `npm run dev` and `npm run preview --workspace apps/desktop` prepare both channel libraries automatically; `npm run build` alone does not. To check the adapters without connecting a bot, run `npm run prepare-runtime --workspace apps/desktop` from the repository root, then `node apps/desktop/scripts/smoke-channel-resolver.mjs`. The check needs no token and sends no messages.

Continuity Studio, the companion prompt, and the Memory View were designed by Marta S and Cassian Varen for AI·DHD.

See [PROVENANCE.md](PROVENANCE.md) for file-level scope and open questions. The included LICENSE, NOTICE, individual file notices, and applicable dependency licenses remain intact. The designers would like a future no-sale policy for eligible original contributions, subject to confirming rights and scope. That intent is not a license condition, does not amend existing grants, and imposes no restriction on upstream code. Cursor integration does not confer rights to redistribute Cursor, its credentials, or its services. Provider names and marks identify their respective services; their own terms apply.
