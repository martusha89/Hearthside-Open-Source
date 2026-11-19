// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { selectCwd, useAppStore } from "../store";

/**
 * Which addresses a piece of markdown may carry.
 *
 * Pictures: only what the window is allowed to show anyway (an inline image, a
 * GIF from the picker, a Letta artifact). Anything else is dropped here rather
 * than left for the browser to refuse, so a reply can't make the window fetch a
 * picture off the disk or the network just by being read.
 *
 * Links: the usual web and mail ones, plus the file links the click handler
 * below opens itself. The library's default strips "file:" and "C:\…" to
 * nothing, which left those links dead.
 */
export function markdownUrl(url: string, key: string): string {
  const value = url.trim();
  if (key === "src") {
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(value)) return value;
    if (/^https:\/\/static\.klipy\.com\//i.test(value)) return value;
    if (/^https:\/\/chat\.letta\.com\/artifacts\//i.test(value)) return value;
    return "";
  }
  if (/^file:\/\//i.test(value) || /^[a-zA-Z]:[\\/]/.test(value)) return value;
  return defaultUrlTransform(value);
}

function ChatImage({ src, alt }: { src?: string; alt?: string }) {
  if (!src) return <span className="memory-media-note">Image not loaded{alt ? `: ${alt}` : "."}</span>;
  return <img src={src} alt={alt ?? ""} className="mt-2 max-w-full rounded-xl" />;
}

// Raw HTML in agent output is deliberately not rendered: it is shown as text.
function MDContent({ text, allowImages = true }: { text: string; allowImages?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      urlTransform={(url, key) => markdownUrl(url, key)}
      components={{
        img: ({ src, alt }) => <ChatImage src={typeof src === "string" ? src : undefined} alt={alt} />,
        // Reading a memory file must not silently fetch a remote tracking image.
        // Chat keeps its existing image behaviour unless the caller opts out.
        ...(!allowImages ? { img: ({ alt }: { alt?: string }) => <span className="memory-media-note">Image not loaded{alt ? `: ${alt}` : "."}</span> } : {}),
        h1: (props) => <h1 className="mt-4 text-xl font-semibold text-ink-900" {...props} />,
        h2: (props) => <h2 className="mt-4 text-lg font-semibold text-ink-900" {...props} />,
        h3: (props) => <h3 className="mt-3 text-base font-semibold text-ink-800" {...props} />,
        p: (props) => <p className="mt-2 leading-relaxed text-ink-800 first:mt-0" {...props} />,
        ul: (props) => <ul className="mt-2 ml-5 grid list-disc gap-1" {...props} />,
        ol: (props) => <ol className="mt-2 ml-5 grid list-decimal gap-1" {...props} />,
        li: (props) => <li className="min-w-0 text-ink-800" {...props} />,
        strong: (props) => <strong className="font-semibold text-ink-900" {...props} />,
        a: ({ href, ...props }) => (
          <a
            className="text-accent underline underline-offset-2 hover:opacity-80"
            target="_blank"
            rel="noreferrer"
            href={href}
            {...props}
            onClick={(event) => {
              // Hearthside: links to files (the runtime's "#letta-sandbox-download/…", file://, a path) open here, or say where the file is.
              if (!href || /^https?:/i.test(href) || /^mailto:/i.test(href)) return;
              const state = useAppStore.getState();
              // Hearthside: Letta's own chat links. "Open computer" opens the chat's Cloud sandbox desktop in the browser.
              if (/^#letta-computer\b/i.test(href)) {
                event.preventDefault();
                if (!state.activeId) return;
                void window.bridge.openLettaComputer(state.activeId).catch((error: unknown) => state.setNotice(error instanceof Error ? error.message : String(error)));
                return;
              }
              if (/^#letta-/i.test(href) && !/letta-sandbox-download/i.test(href)) {
                event.preventDefault();
                state.setNotice("That's a link for Letta's own chat app, which Hearthside doesn't open yet. Ask your agent for a normal web link or the file itself.");
                return;
              }
              if (!/letta-sandbox-download|^file:|^[a-zA-Z]:[\\/]|^\//i.test(href)) return;
              event.preventDefault();
              const cwd = state.activeId ? selectCwd(state, state.activeId) : null;
              void window.bridge
                .openFileLink(href, cwd, state.activeId)
                .then((result) => !result.opened && result.message && state.setNotice(result.message))
                .catch((error: unknown) => state.setNotice(error instanceof Error ? error.message : String(error)));
            }}
          />
        ),
        blockquote: (props) => (
          <blockquote className="mt-2 border-l-2 border-border pl-3 text-ink-600" {...props} />
        ),
        table: (props) => (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm" {...props} />
          </div>
        ),
        th: (props) => (
          <th className="border-b border-border px-2 py-1.5 text-left font-semibold" {...props} />
        ),
        td: (props) => <td className="border-b border-border px-2 py-1.5 align-top" {...props} />,
        pre: (props) => (
          <pre
            className="mt-3 max-w-full overflow-x-auto rounded-xl bg-surface-tertiary p-3 text-[13px] leading-relaxed text-ink-800"
            {...props}
          />
        ),
        code: ({ children, className, ...rest }) => {
          const isBlock = /language-/.test(className ?? "") || String(children).includes("\n");
          return isBlock ? (
            <code className={`${className ?? ""} font-mono`} {...rest}>
              {children}
            </code>
          ) : (
            <code
              className="rounded bg-surface-tertiary px-1.5 py-0.5 font-mono text-[0.9em] text-ink-900"
              {...rest}
            >
              {children}
            </code>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

export default memo(MDContent);
