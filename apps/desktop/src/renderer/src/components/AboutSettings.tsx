import { useEffect, useState } from "react";

export function AboutSettings() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => { void window.bridge.getAppVersion().then(setVersion).catch(() => undefined); }, []);
  return <section className="mt-4 grid gap-3">
    <h2>Hearthside Source Edition{version ? ` ${version}` : ""}</h2>
    <p>Independent desktop client for Letta agents. This build uses a separate local profile and does not receive automatic updates.</p>
    <p>Check with the person who built your copy for updates and support.</p>
  </section>;
}
