import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// Renders user-supplied ticket text as Markdown. react-markdown escapes raw
// HTML by default (no rehype-raw here), so this is safe against stored XSS —
// keep it that way. GFM adds tables, strikethrough, task lists and autolinks.
// Styling is tuned for the compact ticket message bubbles.
const COMPONENTS = {
  a: ({ node, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-brand underline underline-offset-2 hover:opacity-80 break-all"
    />
  ),
  p: ({ node, ...props }) => <p {...props} className="leading-relaxed" />,
  ul: ({ node, ...props }) => (
    <ul {...props} className="list-disc pl-4 space-y-0.5 my-1" />
  ),
  ol: ({ node, ...props }) => (
    <ol {...props} className="list-decimal pl-4 space-y-0.5 my-1" />
  ),
  li: ({ node, ...props }) => <li {...props} className="leading-relaxed" />,
  code: ({ node, inline, ...props }) =>
    inline ? (
      <code
        {...props}
        className="font-mono text-[0.9em] bg-background/70 rounded px-1 py-0.5"
      />
    ) : (
      <code {...props} className="font-mono text-[0.9em]" />
    ),
  pre: ({ node, ...props }) => (
    <pre
      {...props}
      className="bg-background/70 rounded p-2 my-1 overflow-x-auto text-[0.9em]"
    />
  ),
  blockquote: ({ node, ...props }) => (
    <blockquote
      {...props}
      className="border-l-2 border-border pl-2 my-1 text-muted-foreground"
    />
  ),
  h1: ({ node, ...props }) => <h1 {...props} className="font-semibold text-sm my-1" />,
  h2: ({ node, ...props }) => <h2 {...props} className="font-semibold text-sm my-1" />,
  h3: ({ node, ...props }) => <h3 {...props} className="font-semibold my-1" />,
  table: ({ node, ...props }) => (
    <div className="overflow-x-auto my-1">
      <table {...props} className="border-collapse text-[0.95em]" />
    </div>
  ),
  th: ({ node, ...props }) => (
    <th {...props} className="border border-border px-1.5 py-0.5 text-left font-semibold" />
  ),
  td: ({ node, ...props }) => (
    <td {...props} className="border border-border px-1.5 py-0.5" />
  ),
  hr: ({ node, ...props }) => <hr {...props} className="border-border my-2" />,
};

export function Markdown({ children, className }) {
  return (
    <div className={cn("break-words space-y-1", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children ?? ""}
      </ReactMarkdown>
    </div>
  );
}
