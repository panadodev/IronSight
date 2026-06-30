// HTML sanitization for staff-authored rich content (documentation articles).
//
// Doc bodies are produced by the TipTap editor and rendered with
// dangerouslySetInnerHTML on the client. Without sanitization a staffer with
// `docs_edit` could store <script>/onerror/javascript: payloads that execute in
// any `docs_view` viewer's authenticated session (stored XSS). We sanitize at the
// API boundary — on write AND when serving — with an allow-list that preserves the
// rich content the editor actually emits (headings, lists, tables, images, links,
// and YouTube/Vimeo video embeds) while stripping scripts, event handlers, inline
// styles, and untrusted iframes.

import sanitizeHtml from "sanitize-html";

// Video hosts whose <iframe> embeds we allow (the @tiptap/extension-youtube
// extension emits youtube.com/embed iframes). Everything else is dropped.
const ALLOWED_IFRAME_HOSTNAMES = [
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
  "player.vimeo.com",
];

const DOC_SANITIZE_OPTIONS = {
  allowedTags: [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "br",
    "hr",
    "div",
    "span",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "strike",
    "del",
    "ins",
    "mark",
    "sub",
    "sup",
    "blockquote",
    "pre",
    "code",
    "ul",
    "ol",
    "li",
    "a",
    "img",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "td",
    "th",
    "caption",
    "colgroup",
    "col",
    "iframe",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    iframe: [
      "src",
      "width",
      "height",
      "allow",
      "allowfullscreen",
      "frameborder",
      "title",
      "sandbox",
    ],
    div: ["class", "data-youtube-video"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
    col: ["span", "width"],
    span: ["class"],
    p: ["class"],
    code: ["class"],
    pre: ["class"],
    table: ["class"],
  },
  // Links and images may only point at http(s) (and mailto for links); this drops
  // javascript:, data:, and other dangerous schemes.
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    a: ["http", "https", "mailto"],
    img: ["http", "https"],
  },
  allowProtocolRelative: false,
  // Only YouTube/Vimeo iframes survive; any other host (or a relative/js URL) is
  // stripped along with the iframe tag.
  allowedIframeHostnames: ALLOWED_IFRAME_HOSTNAMES,
  allowIframeRelativeUrls: false,
  // We never allow `style`, so there is no need to parse style attributes (also
  // keeps the dependency footprint minimal in edge runtimes).
  parseStyleAttributes: false,
  transformTags: {
    // Force safe link semantics and sandbox video embeds (defense-in-depth on top
    // of the host allow-list).
    a: sanitizeHtml.simpleTransform("a", {
      rel: "noopener noreferrer nofollow",
      target: "_blank",
    }),
    iframe: sanitizeHtml.simpleTransform("iframe", {
      sandbox:
        "allow-scripts allow-same-origin allow-presentation allow-popups",
    }),
  },
};

// Sanitize a documentation article body. Returns a safe HTML string; non-string
// input becomes an empty string. Idempotent — safe to run on both write and read.
export function sanitizeDocHtml(html) {
  if (typeof html !== "string" || html === "") return "";
  return sanitizeHtml(html, DOC_SANITIZE_OPTIONS);
}
