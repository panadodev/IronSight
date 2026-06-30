import { describe, expect, it } from "vitest";
import { sanitizeDocHtml } from "./sanitize.js";

describe("sanitizeDocHtml", () => {
  it("returns an empty string for non-string input", () => {
    expect(sanitizeDocHtml(null)).toBe("");
    expect(sanitizeDocHtml(undefined)).toBe("");
    expect(sanitizeDocHtml(123)).toBe("");
    expect(sanitizeDocHtml("")).toBe("");
  });

  it("removes <script> tags and their contents", () => {
    const out = sanitizeDocHtml("<p>hi</p><script>alert(1)</script>");
    expect(out).toContain("<p>hi</p>");
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert(1)");
  });

  it("strips inline event handlers but keeps the element", () => {
    const out = sanitizeDocHtml(
      '<img src="https://cdn.example.com/y.png" onerror="alert(1)" />',
    );
    expect(out).toContain("img");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert");
  });

  it("drops javascript: links", () => {
    const out = sanitizeDocHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
  });

  it("drops images with a non-http(s) scheme", () => {
    const out = sanitizeDocHtml(
      '<img src="data:text/html,<script>alert(1)</script>" />',
    );
    expect(out).not.toContain("data:");
    expect(out).not.toContain("script");
  });

  it("keeps rich formatting: headings, lists, tables, links, images", () => {
    const input =
      "<h2>Title</h2><ul><li>one</li></ul>" +
      "<table><tbody><tr><td>cell</td></tr></tbody></table>" +
      '<a href="https://example.com">link</a>' +
      '<img src="https://cdn.example.com/a.png" alt="a" />';
    const out = sanitizeDocHtml(input);
    expect(out).toContain("<h2>Title</h2>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<td>cell</td>");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('src="https://cdn.example.com/a.png"');
  });

  it("forces safe rel/target on links", () => {
    const out = sanitizeDocHtml('<a href="https://example.com">x</a>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
  });

  it("allows sandboxed YouTube iframes but drops untrusted iframes", () => {
    const yt = sanitizeDocHtml(
      '<iframe src="https://www.youtube.com/embed/abc123"></iframe>',
    );
    expect(yt).toContain("iframe");
    expect(yt).toContain("youtube.com/embed/abc123");
    expect(yt).toContain("sandbox");

    // An untrusted host has its src stripped, leaving an inert, source-less
    // iframe that loads nothing — the dangerous origin never survives.
    const evil = sanitizeDocHtml(
      '<iframe src="https://evil.example.com/x"></iframe>',
    );
    expect(evil).not.toContain("evil.example.com");
    expect(evil).not.toContain("src=");
  });

  it("is idempotent (sanitizing clean output again is a no-op)", () => {
    const once = sanitizeDocHtml('<h1>t</h1><a href="https://a.com">x</a>');
    expect(sanitizeDocHtml(once)).toBe(once);
  });
});
