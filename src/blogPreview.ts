import MarkdownIt from "markdown-it";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import blogStyleCss from "../../kewu.github.io/src/assets/style.css?raw";
import imageViewerScript from "../../kewu.github.io/src/assets/image-viewer.js?raw";
import codeBlockScript from "../../kewu.github.io/src/assets/code-block.js?raw";

type PreviewInput = {
  title: string;
  description: string;
  body: string;
  currentFilePath: string;
};

const ALIGNMENTS = new Set(["left", "center", "right"]);
const MODES = new Set(["responsive", "fixed", "scale", "responsive-scale"]);

const markdown = createMarkdownRenderer();

export function buildPreviewDocument(input: PreviewInput): string {
  const renderedHtml = resolveRelativeAssetUrls(markdown.render(input.body || ""), input.currentFilePath);
  const articleHtml = renderedHtml.trim() || "<p></p>";
  const headerHtml = input.title || input.description
    ? `
      <header class="post-header">
        ${input.title ? `<h1 class="post-title">${escapeHtml(input.title)}</h1>` : ""}
        ${input.description ? `<p class="post-description">${escapeHtml(input.description)}</p>` : ""}
      </header>
    `
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${escapeInlineStyle(blogStyleCss + "\n" + PREVIEW_OVERRIDES)}</style>
</head>
<body>
  <main class="page-main editor-preview-page">
    <article class="post-article">
      ${headerHtml}
      ${articleHtml}
    </article>
  </main>
  <script>${escapeInlineScript(imageViewerScript)}</script>
  <script>${escapeInlineScript(codeBlockScript)}</script>
</body>
</html>`;
}

function createMarkdownRenderer(): MarkdownIt {
  const md = new MarkdownIt({
    html: true,
    linkify: true
  });

  const defaultImageRender =
    md.renderer.rules.image ||
    function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };

  const defaultHeadingOpen =
    md.renderer.rules.heading_open ||
    function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };

  const defaultParagraphOpen =
    md.renderer.rules.paragraph_open ||
    function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };

  const defaultParagraphClose =
    md.renderer.rules.paragraph_close ||
    function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };

  md.renderer.rules.paragraph_open = function (tokens, idx, options, env, self) {
    if (isImageOnlyParagraph(tokens, idx)) {
      const meta = getImageMetaFromParagraph(tokens, idx);
      const styleParts = [`--image-responsive-scale:${meta.responsiveScale}`];
      if (meta.width) {
        styleParts.push(`--image-width:${meta.width}`);
      }
      if (meta.height) {
        styleParts.push(`--image-height:${meta.height}`);
      }
      if (meta.scale) {
        styleParts.push(`--image-scale:${meta.scale}`);
      }

      return (
        `<figure class="image-module image-align-${meta.align}"` +
        ` data-image-align="${meta.align}"` +
        ` data-image-size-mode="${meta.mode}"` +
        ` data-image-responsive-scale="${meta.responsiveScale}"` +
        ` style="${styleParts.join(";")}">`
      );
    }
    return defaultParagraphOpen(tokens, idx, options, env, self);
  };

  md.renderer.rules.paragraph_close = function (tokens, idx, options, env, self) {
    if (tokens[idx - 2] && isImageOnlyParagraph(tokens, idx - 2)) {
      return "</figure>\n";
    }
    return defaultParagraphClose(tokens, idx, options, env, self);
  };

  md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    if (token.attrGet("id")) {
      return defaultHeadingOpen(tokens, idx, options, env, self);
    }

    const inlineToken = tokens[idx + 1];
    const headingText = getInlineText(inlineToken);
    const baseId = slugifyHeading(headingText);
    const slugCount = ((env as Record<string, unknown>).__headingSlugCount ||= {}) as Record<string, number>;
    const current = slugCount[baseId] || 0;
    slugCount[baseId] = current + 1;
    token.attrSet("id", current === 0 ? baseId : `${baseId}-${current + 1}`);
    return defaultHeadingOpen(tokens, idx, options, env, self);
  };

  md.renderer.rules.image = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const meta = parseImageMeta(token.attrGet("title"));

    if (String(token.attrGet("title") || "").trim().toLowerCase().startsWith("img:")) {
      removeAttr(token, "title");
    }

    token.attrSet("loading", "lazy");
    token.attrSet("decoding", "async");
    token.attrSet("data-image-align", meta.align);
    token.attrSet("data-image-size-mode", meta.mode);
    setAttrIfValue(token, "data-image-responsive-scale", meta.responsiveScale);
    setAttrIfValue(token, "data-image-width", meta.width);
    setAttrIfValue(token, "data-image-height", meta.height);
    setAttrIfValue(token, "data-image-scale", meta.scale);

    return defaultImageRender(tokens, idx, options, env, self);
  };

  return md;
}

function getInlineText(inlineToken: unknown): string {
  if (!inlineToken || typeof inlineToken !== "object" || (inlineToken as { type?: string }).type !== "inline") {
    return "";
  }

  const token = inlineToken as { content?: string; children?: Array<{ type?: string; content?: string }> };
  if (!token.children || token.children.length === 0) {
    return String(token.content || "");
  }

  return token.children
    .filter((child) => child.type === "text" || child.type === "code_inline")
    .map((child) => child.content || "")
    .join("")
    .trim();
}

function slugifyHeading(text: string): string {
  const input = String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return input || "section";
}

function parseImageMeta(titleValue: string | null) {
  const defaults = {
    align: "center",
    mode: "responsive-scale",
    responsiveScale: "50%",
    width: "",
    height: "",
    scale: ""
  };

  if (!titleValue) {
    return defaults;
  }

  const raw = String(titleValue).trim();
  if (!raw.toLowerCase().startsWith("img:")) {
    return defaults;
  }

  const payload = raw.slice(4).trim();
  if (!payload) {
    return defaults;
  }

  for (const part of payload.split(";")) {
    const section = part.trim();
    if (!section) {
      continue;
    }

    const separatorIndex = section.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = section.slice(0, separatorIndex).trim().toLowerCase();
    const value = section.slice(separatorIndex + 1).trim();

    if (key === "align") {
      defaults.align = normalizeAlignment(value);
      continue;
    }
    if (key === "mode" || key === "size" || key === "image-size-mode") {
      defaults.mode = normalizeMode(value);
      continue;
    }
    if (key === "width" || key === "w") {
      defaults.width = normalizeSizeValue(value);
      continue;
    }
    if (key === "height" || key === "h") {
      defaults.height = normalizeSizeValue(value);
      continue;
    }
    if (key === "scale") {
      defaults.scale = normalizeScaleValue(value);
      continue;
    }
    if (key === "ratio" || key === "responsive-scale" || key === "responsiveScale") {
      defaults.responsiveScale = normalizeRatioValue(value) || defaults.responsiveScale;
    }
  }

  return defaults;
}

function normalizeAlignment(value: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  return ALIGNMENTS.has(normalized) ? normalized : "center";
}

function normalizeMode(value: string): string {
  const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "default" || normalized === "responsivescale") {
    return "responsive-scale";
  }
  return MODES.has(normalized) ? normalized : "responsive-scale";
}

function normalizeSizeValue(value: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  if (/^-?\d+(\.\d+)?$/.test(normalized)) {
    return normalized;
  }
  if (/^-?\d+(\.\d+)?(px|%|vw|vh|rem|em)$/.test(normalized)) {
    return normalized;
  }
  return "";
}

function normalizeScaleValue(value: string): string {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "";
  }
  return String(parsed);
}

function normalizeRatioValue(value: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  if (/^-?\d+(\.\d+)?%$/.test(normalized)) {
    return normalized;
  }
  if (/^-?\d+(\.\d+)?$/.test(normalized)) {
    return normalized;
  }
  return "";
}

function removeAttr(token: { attrIndex(name: string): number; attrs: string[][] }, attrName: string): void {
  const index = token.attrIndex(attrName);
  if (index >= 0) {
    token.attrs.splice(index, 1);
  }
}

function setAttrIfValue(token: { attrSet(name: string, value: string): void }, key: string, value: string): void {
  if (!value) {
    return;
  }
  token.attrSet(key, value);
}

function isImageOnlyParagraph(tokens: Array<{ type?: string; children?: Array<{ type?: string }> }>, idx: number): boolean {
  if (!tokens[idx] || tokens[idx].type !== "paragraph_open") {
    return false;
  }
  const inlineToken = tokens[idx + 1];
  const closeToken = tokens[idx + 2];
  if (!inlineToken || inlineToken.type !== "inline" || !closeToken || closeToken.type !== "paragraph_close") {
    return false;
  }
  const children = inlineToken.children || [];
  return children.length === 1 && children[0].type === "image";
}

function getImageMetaFromParagraph(tokens: Array<{ children?: Array<{ attrGet(name: string): string | null }> }>, idx: number) {
  const inlineToken = tokens[idx + 1];
  const imageToken = inlineToken.children?.[0];
  return {
    align: normalizeAlignment(imageToken?.attrGet("data-image-align") || ""),
    mode: normalizeMode(imageToken?.attrGet("data-image-size-mode") || ""),
    responsiveScale: normalizeRatioValue(imageToken?.attrGet("data-image-responsive-scale") || "") || "50%",
    width: normalizeSizeValue(imageToken?.attrGet("data-image-width") || ""),
    height: normalizeSizeValue(imageToken?.attrGet("data-image-height") || ""),
    scale: normalizeScaleValue(imageToken?.attrGet("data-image-scale") || "")
  };
}

function resolveRelativeAssetUrls(html: string, currentFilePath: string): string {
  if (!html || !currentFilePath) {
    return html;
  }

  const documentNode = document.implementation.createHTMLDocument("");
  documentNode.body.innerHTML = html;
  const baseDirectory = getDirectoryPath(currentFilePath);

  for (const element of Array.from(documentNode.body.querySelectorAll<HTMLElement>("[src], [href]"))) {
    if (element.hasAttribute("src")) {
      const src = element.getAttribute("src") || "";
      const nextSrc = rewriteUrl(src, baseDirectory);
      if (nextSrc) {
        element.setAttribute("src", nextSrc);
      }
    }

    if (element.hasAttribute("href")) {
      const href = element.getAttribute("href") || "";
      const nextHref = rewriteUrl(href, baseDirectory);
      if (nextHref) {
        element.setAttribute("href", nextHref);
      }
    }
  }

  return documentNode.body.innerHTML;
}

function rewriteUrl(rawUrl: string, baseDirectory: string): string {
  const value = String(rawUrl || "").trim();
  if (!value || !isRelativeUrl(value)) {
    return value;
  }

  const resolvedPath = resolveLocalPath(baseDirectory, value);
  if (isTauri()) {
    return convertFileSrc(resolvedPath);
  }

  return `file:///${resolvedPath.replace(/\\/g, "/")}`;
}

function isRelativeUrl(value: string): boolean {
  return !/^(?:[a-z]+:|#|\/\/)/i.test(value) && !value.startsWith("/");
}

function getDirectoryPath(filePath: string): string {
  return String(filePath || "").replace(/[\\/][^\\/]*$/, "");
}

function resolveLocalPath(baseDirectory: string, relativePath: string): string {
  const separator = baseDirectory.includes("\\") ? "\\" : "/";
  const baseSegments = baseDirectory.split(/[\\/]/).filter(Boolean);
  const relativeSegments = relativePath.split("/").filter(Boolean);
  const prefix = /^[A-Za-z]:$/.test(baseSegments[0] || "") ? `${baseSegments.shift()}${separator}` : "";
  const segments = [...baseSegments];

  for (const segment of relativeSegments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return `${prefix}${segments.join(separator)}`;
}

function escapeInlineScript(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script");
}

function escapeInlineStyle(code: string): string {
  return code.replace(/<\/style/gi, "<\\/style");
}

function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PREVIEW_OVERRIDES = `
html {
  scrollbar-gutter: auto;
}

body {
  background: #f7f8fa;
}

.editor-preview-page {
  max-width: none;
  width: auto;
  margin: 0;
  padding: 14px;
}

.editor-preview-page .post-article {
  min-height: auto;
  border-radius: 16px;
  box-shadow: none;
  padding: 18px;
}
`;
