import { Marked, Renderer } from "marked";
import hljs from "highlight.js";
import markedKatex from "marked-katex-extension";
import sanitizeHtml from "sanitize-html";

export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );

// Render in the integration process: parser/highlighter libraries never consume
// the Notch's HTML budget. The resulting markup follows the same bounded message
// transport as text, including automatic loading for very large replies.
const renderer = new Renderer();
const baseTable = renderer.table;
renderer.table = function (token) {
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="Message table">${baseTable.call(this, token)}</div>`;
};
renderer.code = ({ text, lang }) => {
  const language = lang?.trim().split(/\s+/)[0] ?? "";
  let code = escapeHtml(text);
  // Preserve long/unknown code verbatim; avoid costly language guessing.
  if (language && hljs.getLanguage(language) && text.length <= 100_000) {
    try {
      code = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      /* plain code remains readable */
    }
  }
  return `<div class="code-block">${language ? `<div class="code-language">${escapeHtml(language)}</div>` : ""}<pre tabindex="0"><code class="hljs">${code}</code></pre></div>`;
};
renderer.html = ({ text }) => {
  // Match Grok's small set of literal formatting tags; arbitrary HTML is text.
  // In particular a transcript cannot create a widget button or a script.
  return /^<\/?(?:br|b|strong|i|em|s|del|u|sub|sup|kbd|mark)\s*\/?>$/i.test(
    text,
  )
    ? text
    : escapeHtml(text);
};
renderer.link = function ({ href, title, tokens }) {
  const label = this.parser.parseInline(tokens);
  try {
    const url = new URL(href);
    if (url.protocol === "https:" && !url.username && !url.password) {
      return `<a href="${escapeHtml(url.href)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${label}</a>`;
    }
  } catch {
    /* non-web references remain readable */
  }
  return label;
};
// Attachments are resolved separately through Grok's authenticated media reader.
// Never turn transcript-supplied image URLs into browser network requests.
renderer.image = () => "";

const markdown = new Marked({ gfm: true, breaks: true, renderer });
markdown.use(
  markedKatex({
    output: "mathml",
    throwOnError: false,
    trust: false,
    strict: "ignore",
    maxExpand: 1000,
    maxSize: 20,
  }),
);

export function markdownImages(text: string): { url: string; alt: string }[] {
  if (!text.includes("![")) return [];
  const images: { url: string; alt: string }[] = [];
  markdown.walkTokens(markdown.lexer(text), (token) => {
    if (token.type === "image")
      images.push({ url: token.href, alt: token.text });
  });
  return images;
}

const mathTags = [
  "math",
  "semantics",
  "annotation",
  "mrow",
  "mi",
  "mn",
  "mo",
  "mtext",
  "mspace",
  "ms",
  "mfrac",
  "msqrt",
  "mroot",
  "mstyle",
  "merror",
  "mpadded",
  "mphantom",
  "mfenced",
  "menclose",
  "msub",
  "msup",
  "msubsup",
  "munder",
  "mover",
  "munderover",
  "mmultiscripts",
  "mprescripts",
  "none",
  "mtable",
  "mtr",
  "mtd",
];
const cache = new Map<string, string>();
let cacheChars = 0;
export function renderMarkdown(text: string): string {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  let html: string;
  try {
    html = sanitizeHtml(markdown.parse(text, { async: false }), {
      allowedTags: [
        ...sanitizeHtml.defaults.allowedTags,
        "input",
        "span",
        "del",
        "s",
        "kbd",
        "mark",
        ...mathTags,
      ],
      allowedAttributes: {
        "*": ["class"],
        a: ["href", "title"],
        div: ["class", "tabindex", "role", "aria-label"],
        pre: ["tabindex"],
        ol: ["start"],
        input: ["type", "checked", "disabled"],
        th: ["align", "style"],
        td: ["align", "style"],
        ...Object.fromEntries(
          mathTags.map((tag) => [
            tag,
            [
              "xmlns",
              "display",
              "encoding",
              "mathvariant",
              "displaystyle",
              "scriptlevel",
              "stretchy",
              "fence",
              "separator",
              "accent",
              "accentunder",
              "width",
              "height",
              "depth",
              "lspace",
              "rspace",
              "minsize",
              "maxsize",
              "rowspacing",
              "columnspacing",
              "rowalign",
              "columnalign",
              "rowlines",
              "columnlines",
              "linethickness",
              "notation",
              "voffset",
            ],
          ]),
        ),
      },
      allowedStyles: { "*": { "text-align": [/^(left|right|center)$/] } },
      allowedSchemes: ["https"],
      allowProtocolRelative: false,
    });
  } catch {
    // A malformed message must still be readable in full.
    html = `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  }
  const chars = text.length + html.length;
  if (chars <= 2_000_000) {
    while (cache.size && (cache.size >= 32 || cacheChars + chars > 4_000_000)) {
      const key = cache.keys().next().value!;
      cacheChars -= key.length + cache.get(key)!.length;
      cache.delete(key);
    }
    cache.set(text, html);
    cacheChars += chars;
  }
  return html;
}

export const markdownCss = String.raw`
.bubble{min-width:0}.bubble>:first-child{margin-top:0}.bubble>:last-child{margin-bottom:0}
.bubble p{margin:0 0 9px}.bubble h1,.bubble h2,.bubble h3,.bubble h4,.bubble h5,.bubble h6{font-weight:650;line-height:1.3;margin:14px 0 7px}.bubble h1{font-size:21px}.bubble h2{font-size:18px}.bubble h3{font-size:16px}.bubble h4,.bubble h5,.bubble h6{font-size:14px}
.bubble ul,.bubble ol{margin:7px 0;padding-left:22px}.bubble li{margin:3px 0}.bubble li>p{margin:5px 0}.bubble li input{accent-color:#a0a0a0;margin:0 6px 0 0}.bubble blockquote{margin:9px 0;border-left:3px solid #666;padding:2px 0 2px 10px;color:#bfbfbf}.bubble hr{border:0;border-top:1px solid #484848;margin:12px 0}
.bubble code{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.bubble :not(pre)>code{color:#ff5367;background:#ffffff0d;border:1px solid #ffffff0a;border-radius:4px;padding:0 3px;box-decoration-break:clone}.bubble kbd{font:11px ui-monospace,monospace;border:1px solid #666;border-radius:3px;padding:1px 4px}
.code-block{min-width:0;max-width:100%;margin:9px 0;background:#161616;border:1px solid #414141;border-radius:8px;overflow:hidden}.code-language{padding:5px 9px;font-size:10px;color:#aaa;border-bottom:1px solid #333}.bubble pre{margin:0;padding:10px;max-width:100%;white-space:pre;overflow:auto;overscroll-behavior-x:contain;background:#161616}.bubble pre code{color:#ddd;background:transparent;padding:0;border:0;white-space:pre;overflow-wrap:normal}
.table-scroll{max-width:100%;overflow:auto;overscroll-behavior-x:contain;margin:9px 0}.bubble table{border-collapse:collapse;width:100%;min-width:360px;font-size:12px}.bubble th,.bubble td{border-bottom:1px solid #454545;padding:7px 9px;text-align:left;min-width:80px;max-width:300px;vertical-align:top}.bubble th{font-weight:600;color:#eee;background:#2c2c2c}.bubble td{color:#ddd}.bubble th[align=right],.bubble td[align=right]{text-align:right}.bubble th[align=center],.bubble td[align=center]{text-align:center}
.hljs-comment,.hljs-quote{color:#969896}.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-type{color:#c792ea}.hljs-string,.hljs-regexp,.hljs-addition{color:#a5d6a7}.hljs-number,.hljs-symbol,.hljs-bullet{color:#f7ba7e}.hljs-title,.hljs-section,.hljs-attribute{color:#82aaff}.hljs-variable,.hljs-template-variable,.hljs-attr,.hljs-deletion{color:#ff7385}.hljs-built_in,.hljs-meta{color:#89ddff}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}
.bubble math[display=block]{display:block;max-width:100%;overflow:auto;padding:8px 0}.bubble .katex-display{display:block;max-width:100%;overflow:auto;margin:8px 0}
`;
