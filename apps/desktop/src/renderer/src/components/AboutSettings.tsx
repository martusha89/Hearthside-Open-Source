import { useEffect, useState } from "react";

export function AboutSettings() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => { void window.bridge.getAppVersion().then(setVersion).catch(() => undefined); }, []);
  return <section className="mt-4 grid gap-3">
    <h2>Hearthside Source Edition{version ? ` ${version}` : ""}</h2>
    <p>An independent companion desktop built on Letta. This edition keeps its own local profile and never enters the official Hearthside update channel.</p>
    <p>Source builders control their own changes, releases, updates and support.</p>
  </section>;
}
