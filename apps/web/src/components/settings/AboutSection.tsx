import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { api } from "@/api";
import { t } from "@/i18n/settings";

const AUTHOR = "aleks-spv";

export default function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    api.systemHealth().then((h) => setVersion(h.version), () => setVersion(null));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">SysAiAdm Station</h2>
        <p className="text-muted-foreground">{t("about.edition")}</p>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
        <dt className="text-muted-foreground">{t("about.version")}</dt>
        <dd className="font-mono">{version ?? "—"}</dd>
        <dt className="text-muted-foreground">{t("about.author")}</dt>
        <dd>
          <a
            href={`https://github.com/${AUTHOR}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline"
          >
            <ExternalLink className="size-4" />
            {AUTHOR}
          </a>
        </dd>
        <dt className="text-muted-foreground">{t("about.license")}</dt>
        <dd>AGPL-3.0-only</dd>
      </dl>
      <p className="text-muted-foreground">{t("about.community")}</p>
    </div>
  );
}
