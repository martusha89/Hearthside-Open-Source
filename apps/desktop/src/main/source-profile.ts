import { app } from "electron";
import { join } from "node:path";
// Keep main-process memory/import paths and runtime children on the same local store,
// even when launched from a shell configured for another Letta installation.
delete process.env.LETTA_LOCAL_BACKEND_DIR;
app.setName("Hearthside Source Edition");
app.setPath("userData", join(app.getPath("appData"), "hearthside-source-edition"));
app.setAppUserModelId("org.hearthside.sourceedition");
