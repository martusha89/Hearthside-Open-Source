# Feature provenance — working draft

Reference: selected tracked files at `936f56653c568497a0371ca3f26981f08d19c66f`. Paths below are relative to `apps/desktop/src/`. This is a map of the shipped implementation, not a declaration that every line is original or that every file has been cleared for relicensing.

| Feature | Reference file | Scope and open questions |
| --- | --- | --- |
| Continuity Studio | `renderer/src/components/CompanionBuilder.tsx` | Builder interface. Design credit below; individual contributions and any reused UI portions need review. |
| Continuity Studio | `main/libs/history-import.ts` | Import implementation. No ownership claim over supported export formats or users’ conversations. Original samples are not part of the grant. |
| Companion prompt | `renderer/src/lib/companion-prompt.ts` | Prompt construction. Credit for design does not establish ownership of each text fragment or helper. Review text and implementation separately. |
| Companion prompt | `renderer/src/lib/companion-technical.ts` | Its header identifies the delivered repaired companion text as its source, distinct from Letta's managed default. The delivered document was not imported; its edit history and permission to change terms have not been verified. |
| Companion prompt / Studio | `renderer/src/lib/companion.ts` | The file header identifies a port of `src/domain.ts`, `src/generate.ts`, and `src/memory-review.ts` from [Continuity Studio](https://github.com/martusha89/continuity-studio), Apache-2.0. The precise upstream revision and extent of subsequent changes remain unverified. |
| Memory View | `renderer/src/components/MemoryView.tsx` | View implementation. Review any inherited UI code separately from interaction design. |
| Memory View | `renderer/src/lib/memory-cosmos-layout.ts`, `renderer/src/lib/memory-graph.ts` | Layout and graph logic. Per-line origin and third-party contributions not yet established. |
| Memory View | `renderer/src/lib/memory-cosmos-renderer.ts` | Adapted radial glow and Three.js / HTML-label / bloom composition from CosmoGraph; the adjacent `memory-cosmos.LICENSE` covers the adapted portions, not the entire renderer. Preserve it. |

Continuity Studio, the companion prompt, and the Memory View were designed by Marta S and Cassian Varen for AI·DHD.

Do not infer sole copyright ownership, assignments, consent to relicensing, or rights in service names from design credit or Git authorship. Before considering different terms, identify upstream matches and contributors, review dependency and asset notices, and confirm rights in each separable original contribution. Existing Apache, MIT and other grants are unaffected.
