# Product direction: a companion's living place

This document governs the public-source edition rebuild on Cass's branch. It is based on the current application and current source, not the superseded roadmap.

## The organising idea

Hearthside is not a chat client with companion features attached. It is a place organised around one companion at a time.

The application has five territories:

1. **Presence** — who is here, what is alive now, and the quickest way back into contact.
2. **Conversations** — the main relationship thread and the other rooms a companion shares with a person.
3. **Memory** — the companion's continuity as inspectable files, history, dreams, and relationships.
4. **Reach** — channels, schedules, and calendar: where and when the companion can meet the world.
5. **Work** — skills, connectors, files, tools, and execution places.

## Product principles

- **The companion is the subject, not a selected resource.** Names, pictures, continuity, activity, and conversations lead. Models and backends remain available without becoming the identity of the app.
- **Presence must answer, not gesture.** Its space is earned by observed current activity, recent conversation substance, memory change, connected reach, and upcoming shared time—not larger duplicates of sidebar links.
- **Do not fake inner states.** Hearthside may show observed activity, waiting work, memory changes, and connection state. It will not invent a mood or claim a companion is present when no runtime is connected.
- **Keep power; improve hierarchy.** The rebuild does not delete advanced controls to manufacture simplicity. It puts them where their meaning is clear.
- **Memory remains first-class.** The existing memory cosmos is original and central. It is preserved, not replaced by a dashboard summary.
- **Conversation remains immediate.** A person can always return to the main chat in one action. Presence does not become an obstacle before speaking.
- **Safety stays explicit.** Approvals must make the proposed action and target legible. Softer presentation must never make consequential actions look casual.
- **Infrastructure is context, not personality.** Local, Cloud, remote execution, providers, and models are visible when they matter and quiet when they do not.
- **No redesign for theatre.** Existing Hearthside work stays when it already serves the idea. Change must improve orientation, continuity, or contact.

## Implemented rebuild baseline

The initial rebuild establishes the new hierarchy without replacing proven runtime paths:

- Add **Presence** as a companion-centred home.
- Ground Presence in bounded recent-message previews, explicit attention state, latest memory activity, companion-owned channel status, active schedules, and shared calendar access.
- Reorganise navigation around Presence, Memory, Reach, Work, and Conversations.
- Give conversation headers the companion's identity as well as the room title.
- Give the source edition a violet-and-teal default visual register while preserving each companion's chosen accent, avatar, and chat background.
- Present approvals as deliberate trust decisions, with the exact request still available for inspection.
- Separate companion identity settings from model and runtime machinery.
- Align onboarding, supporting-page headers, source-edition branding, and the guided tour with the companion-led hierarchy.
- Preserve all store, IPC, streaming, scrolling, queue, approval, recovery, and memory-cosmos behaviour.
