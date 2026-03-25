import "./style.css";
import "./editor.css";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { buildPreviewDocument } from "./blogPreview";
import {
  buildTree,
  formatUpdatedAt,
  getEmptySnapshot,
  type PostRecord,
  type RepositorySnapshot,
  type TreeNode
} from "./postIndex";

type SessionState = {
  projectPath: string;
};

type InsertTargetKind = "root" | "category" | "post";
type EditorMode = "new" | "edit";

type SavePostRequest = {
  projectPath: string;
  title: string;
  description: string;
  body: string;
  category: string;
  parent: string;
  existingSlug: string;
  existingFilePath: string;
  date: string;
  order: number;
};

type PostDocument = {
  title: string;
  description: string;
  body: string;
  date: string;
  slug: string;
  category: string;
  parent: string;
  order: number;
  filePath: string;
};

type EditorState = {
  session: SessionState | null;
  snapshot: RepositorySnapshot;
  loading: boolean;
  saving: boolean;
  error: string;
  saveMessage: string;
  toolbarCollapsed: boolean;
  articlesCollapsed: boolean;
  tocCollapsed: boolean;
  previewCollapsed: boolean;
  articlesWidth: number;
  tocWidth: number;
  previewWidth: number;
  mode: EditorMode;
  targetKind: InsertTargetKind;
  targetId: string;
  routeSlug: string;
  title: string;
  description: string;
  body: string;
  currentSlug: string;
  currentFilePath: string;
  currentCategory: string;
  currentParent: string;
  currentDate: string;
  currentOrder: number;
};

const STORAGE_KEY = "kewu-cms:session";
const DRAFT_UID = "draft:new";
const STORAGE_ARTICLES_WIDTH_KEY = "kewu-cms:editor-articles-width";
const STORAGE_TOC_WIDTH_KEY = "kewu-cms:editor-toc-width";
const STORAGE_PREVIEW_WIDTH_KEY = "kewu-cms:editor-preview-width";
const STORAGE_ARTICLES_COLLAPSED_KEY = "kewu-cms:editor-articles-collapsed";
const STORAGE_TOC_COLLAPSED_KEY = "kewu-cms:editor-toc-collapsed";
const STORAGE_PREVIEW_COLLAPSED_KEY = "kewu-cms:editor-preview-collapsed";
const DEFAULT_ARTICLES_WIDTH = 320;
const DEFAULT_TOC_WIDTH = 260;
const DEFAULT_PREVIEW_WIDTH = 460;
const MIN_ARTICLES_WIDTH = 180;
const MIN_TOC_WIDTH = 180;
const MIN_PREVIEW_WIDTH = 280;
const params = new URLSearchParams(window.location.search);
const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found.");
}

const state: EditorState = {
  session: readSession(),
  snapshot: getEmptySnapshot(),
  loading: false,
  saving: false,
  error: "",
  saveMessage: "",
  toolbarCollapsed: false,
  articlesCollapsed: readBool(STORAGE_ARTICLES_COLLAPSED_KEY, false),
  tocCollapsed: readBool(STORAGE_TOC_COLLAPSED_KEY, false),
  previewCollapsed: readBool(STORAGE_PREVIEW_COLLAPSED_KEY, false),
  articlesWidth: readNumber(STORAGE_ARTICLES_WIDTH_KEY, DEFAULT_ARTICLES_WIDTH),
  tocWidth: readNumber(STORAGE_TOC_WIDTH_KEY, DEFAULT_TOC_WIDTH),
  previewWidth: readNumber(STORAGE_PREVIEW_WIDTH_KEY, DEFAULT_PREVIEW_WIDTH),
  mode: parseMode(params.get("mode")),
  targetKind: parseTargetKind(params.get("targetKind")),
  targetId: params.get("targetId") || "",
  routeSlug: params.get("slug") || "",
  title: "",
  description: "",
  body: "",
  currentSlug: "",
  currentFilePath: "",
  currentCategory: "",
  currentParent: "",
  currentDate: new Date().toISOString().slice(0, 10),
  currentOrder: 999
};

function readSession(): SessionState | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as SessionState;
    return parsed.projectPath ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function parseMode(value: string | null): EditorMode {
  return value === "edit" ? "edit" : "new";
}

function parseTargetKind(value: string | null): InsertTargetKind {
  if (value === "category" || value === "post") {
    return value;
  }
  return "root";
}

function readNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) {
      return fallback;
    }
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch (_error) {
    return fallback;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) {
      return fallback;
    }
    return raw === "1";
  } catch (_error) {
    return fallback;
  }
}

function writeValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch (_error) {
    // ignore
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampArticlesWidth(value: number): number {
  return clamp(value, MIN_ARTICLES_WIDTH, Math.max(MIN_ARTICLES_WIDTH + 40, Math.floor(window.innerWidth * 0.32)));
}

function clampTocWidth(value: number): number {
  return clamp(value, MIN_TOC_WIDTH, Math.max(MIN_TOC_WIDTH + 40, Math.floor(window.innerWidth * 0.28)));
}

function clampPreviewWidth(value: number): number {
  return clamp(value, MIN_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH + 40, Math.floor(window.innerWidth * 0.42)));
}

function persistLayoutState(): void {
  writeValue(STORAGE_ARTICLES_WIDTH_KEY, String(state.articlesWidth));
  writeValue(STORAGE_TOC_WIDTH_KEY, String(state.tocWidth));
  writeValue(STORAGE_PREVIEW_WIDTH_KEY, String(state.previewWidth));
  writeValue(STORAGE_ARTICLES_COLLAPSED_KEY, state.articlesCollapsed ? "1" : "0");
  writeValue(STORAGE_TOC_COLLAPSED_KEY, state.tocCollapsed ? "1" : "0");
  writeValue(STORAGE_PREVIEW_COLLAPSED_KEY, state.previewCollapsed ? "1" : "0");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadRepositorySnapshot(projectPath: string): Promise<RepositorySnapshot> {
  if (!isTauri()) {
    return getEmptySnapshot();
  }

  return invoke<RepositorySnapshot>("load_repository_snapshot", { projectPath });
}

async function loadPostDocument(filePath: string): Promise<PostDocument> {
  return invoke<PostDocument>("load_post_document", { filePath });
}

function buildPostEditorUrl(slug: string): string {
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set("mode", "edit");
  url.searchParams.set("slug", slug);
  return url.toString();
}

function syncEditorUrl(slug: string): void {
  window.history.replaceState({}, "", buildPostEditorUrl(slug));
}

function createDraftNode(): TreeNode {
  return {
    uid: DRAFT_UID,
    id: DRAFT_UID,
    kind: "post",
    title: state.title.trim() || "未命名文章",
    description: state.description.trim(),
    date: state.currentDate,
    slug: "",
    category: state.currentCategory,
    parent: state.currentParent,
    order: state.currentOrder,
    fileName: "",
    filePath: "",
    updatedAtMs: 0,
    children: []
  };
}

function cloneTreeNode(node: TreeNode): TreeNode {
  return {
    ...node,
    children: node.children.map(cloneTreeNode)
  };
}

function getCurrentHighlightUid(): string {
  return state.currentSlug ? `post:${state.currentSlug}` : DRAFT_UID;
}

function insertDraftNode(nodes: TreeNode[], draftNode: TreeNode): TreeNode[] {
  if (state.currentSlug) {
    return nodes;
  }

  if (state.targetKind === "root") {
    return [draftNode, ...nodes];
  }

  const nextNodes = nodes.map(cloneTreeNode);
  const queue: TreeNode[] = [...nextNodes];

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) {
      continue;
    }

    if (state.targetKind === "category" && node.kind === "category" && node.id === state.targetId) {
      node.children.unshift(draftNode);
      return nextNodes;
    }

    if (state.targetKind === "post" && node.kind === "post" && node.id === state.targetId) {
      node.children.unshift(draftNode);
      return nextNodes;
    }

    queue.push(...node.children);
  }

  nextNodes.unshift(draftNode);
  return nextNodes;
}

function getTreeNodeTitleMarkup(node: TreeNode): string {
  if (node.kind !== "post" || !node.slug) {
    return `<span class="content-tree-label">${escapeHtml(node.title)}</span>`;
  }

  return `
    <button class="content-tree-open" type="button" data-switch-post-slug="${escapeHtml(node.slug)}">
      <span class="content-tree-label">${escapeHtml(node.title)}</span>
    </button>
  `;
}

function renderArticleTreeNodes(nodes: TreeNode[]): string {
  if (nodes.length === 0) {
    return `<p class="empty-state">当前没有文章。</p>`;
  }

  const currentUid = getCurrentHighlightUid();

  return `
    <ol class="content-tree-list">
      ${nodes
        .map(function (node) {
          const hasChildren = node.children.length > 0;
          const description = node.description ? `<p class="content-tree-description">${escapeHtml(node.description)}</p>` : "";
          const meta = node.updatedAtMs ? `<p class="content-tree-meta">${escapeHtml(formatUpdatedAt(node.updatedAtMs))}</p>` : "";
          const currentClass = node.uid === currentUid ? " is-current" : "";

          return `
            <li class="content-tree-item content-tree-item-${node.kind}${hasChildren ? " has-children" : ""}${currentClass}">
              ${hasChildren
                ? '<button class="content-tree-toggle" type="button" aria-expanded="true" aria-label="收起子节点"></button>'
                : '<span class="content-tree-toggle-placeholder" aria-hidden="true"></span>'}
              <div class="content-tree-entry">
                <div class="content-tree-title-row content-tree-title-row-${node.kind}">
                  ${getTreeNodeTitleMarkup(node)}
                </div>
                ${description}
                ${meta}
              </div>
              ${hasChildren ? renderArticleTreeNodes(node.children) : ""}
            </li>
          `;
        })
        .join("")}
    </ol>
  `;
}

function getArticleTreeMarkup(): string {
  const baseTree = buildTree(state.snapshot, "title", "asc");
  const withDraft = insertDraftNode(baseTree, createDraftNode());
  return renderArticleTreeNodes(withDraft);
}

type TocItem = {
  level: number;
  title: string;
  depth: number;
  hasChildren: boolean;
};

function parseTocItems(body: string): TocItem[] {
  const lines = body.split(/\r?\n/);
  const items: TocItem[] = [];
  const levelStack: number[] = [];

  for (const line of lines) {
    const match = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      continue;
    }

    const level = match[1].length;
    while (levelStack.length > 0 && level <= levelStack[levelStack.length - 1]) {
      levelStack.pop();
    }

    items.push({
      level,
      title: match[2].trim(),
      depth: levelStack.length,
      hasChildren: false
    });

    levelStack.push(level);
  }

  for (let index = 0; index < items.length; index += 1) {
    const current = items[index];
    for (let nextIndex = index + 1; nextIndex < items.length; nextIndex += 1) {
      const next = items[nextIndex];
      if (next.depth <= current.depth) {
        break;
      }
      current.hasChildren = true;
      break;
    }
  }

  return items;
}

function getTocMarkup(): string {
  const items = parseTocItems(state.body);
  if (items.length === 0) {
    return `<p class="empty-state">正文中暂无目录标题。</p>`;
  }

  return `
    <ol class="editor-toc-list">
      ${items
        .map(function (item) {
          return `
            <li class="editor-toc-item editor-toc-level-${item.level} editor-toc-depth-${item.depth}${item.hasChildren ? " has-children" : ""}" data-level="${item.level}" data-depth="${item.depth}" data-collapsed="0">
              ${item.hasChildren
                ? '<button class="editor-toc-toggle-btn" type="button" aria-expanded="true" aria-label="收起子标题"></button>'
                : '<span class="editor-toc-toggle-btn" aria-hidden="true"></span>'}
              <span class="editor-toc-link">${escapeHtml(item.title)}</span>
            </li>
          `;
        })
        .join("")}
    </ol>
  `;
}

function getEditorGridTemplate(): string {
  state.articlesWidth = clampArticlesWidth(state.articlesWidth);
  state.tocWidth = clampTocWidth(state.tocWidth);
  state.previewWidth = clampPreviewWidth(state.previewWidth);

  const articleWidth = state.articlesCollapsed ? "0" : `${state.articlesWidth}px`;
  const tocWidth = state.tocCollapsed ? "0" : `${state.tocWidth}px`;
  const previewWidth = state.previewCollapsed ? "0" : `${state.previewWidth}px`;
  return `${articleWidth} 14px ${tocWidth} 14px minmax(0, 1fr) 14px ${previewWidth}`;
}

function applyLayoutToDom(): void {
  const layoutEl = app.querySelector<HTMLElement>(".editor-layout");
  if (!layoutEl) {
    return;
  }

  layoutEl.classList.toggle("is-articles-collapsed", state.articlesCollapsed);
  layoutEl.classList.toggle("is-toc-collapsed", state.tocCollapsed);
  layoutEl.classList.toggle("is-preview-collapsed", state.previewCollapsed);
  layoutEl.style.setProperty("--editor-grid-template", getEditorGridTemplate());

  const articlesButton = app.querySelector<HTMLButtonElement>("[data-action='toggle-articles']");
  if (articlesButton) {
    articlesButton.textContent = state.articlesCollapsed ? ">" : "<";
    articlesButton.setAttribute("aria-expanded", String(!state.articlesCollapsed));
  }

  const tocButton = app.querySelector<HTMLButtonElement>("[data-action='toggle-toc']");
  if (tocButton) {
    tocButton.textContent = state.tocCollapsed ? ">" : "<";
    tocButton.setAttribute("aria-expanded", String(!state.tocCollapsed));
  }

  const previewButton = app.querySelector<HTMLButtonElement>("[data-action='toggle-preview']");
  if (previewButton) {
    previewButton.textContent = state.previewCollapsed ? "<" : ">";
    previewButton.setAttribute("aria-expanded", String(!state.previewCollapsed));
  }
}

function renderToolbar(): string {
  return `
    <header class="editor-toolbar${state.toolbarCollapsed ? " is-collapsed" : ""}">
      <div class="editor-toolbar-inner">
        <div class="editor-toolbar-actions">
          <button class="editor-toolbar-button editor-toolbar-button-primary" type="button" data-action="save-post">
            ${state.saving ? "保存中..." : "保存"}
          </button>
          ${state.saveMessage ? `<span class="editor-toolbar-status">${escapeHtml(state.saveMessage)}</span>` : ""}
        </div>
      </div>
      <button class="editor-toolbar-toggle" type="button" data-action="toggle-toolbar" aria-expanded="${String(!state.toolbarCollapsed)}">
        ${state.toolbarCollapsed ? "展开" : "收起"}
      </button>
    </header>
  `;
}

function render(): void {
  if (!state.session) {
    app.innerHTML = `
      <div class="editor-shell">
        <section class="content-panel content-panel-empty">
          <h1 class="page-title">未找到已登录的文章仓库</h1>
        </section>
      </div>
    `;
    return;
  }

  if (state.loading) {
    app.innerHTML = `
      <div class="editor-shell">
        ${renderToolbar()}
        <section class="content-panel">
          <p class="empty-state">正在加载文章内容...</p>
        </section>
      </div>
    `;
    bindToolbar();
    return;
  }

  if (state.error) {
    app.innerHTML = `
      <div class="editor-shell">
        ${renderToolbar()}
        <section class="content-panel">
          <p class="error-state">${escapeHtml(state.error)}</p>
        </section>
      </div>
    `;
    bindToolbar();
    return;
  }

  const layoutClasses = [
    "editor-layout",
    state.articlesCollapsed ? "is-articles-collapsed" : "",
    state.tocCollapsed ? "is-toc-collapsed" : "",
    state.previewCollapsed ? "is-preview-collapsed" : ""
  ]
    .filter(Boolean)
    .join(" ");

  app.innerHTML = `
    <div class="editor-shell">
      ${renderToolbar()}
      <main class="${layoutClasses}" style="--editor-grid-template:${getEditorGridTemplate()}">
        <aside class="editor-pane editor-pane-tree">
          <div class="editor-pane-header">
            <span class="editor-pane-title">文章列表</span>
          </div>
          <div class="editor-pane-body editor-tree-host">
            ${getArticleTreeMarkup()}
          </div>
        </aside>
        <div class="editor-splitter editor-splitter-tree" role="separator" aria-orientation="vertical">
          <button class="editor-splitter-toggle" type="button" data-action="toggle-articles" aria-expanded="${String(!state.articlesCollapsed)}">
            ${state.articlesCollapsed ? ">" : "<"}
          </button>
        </div>
        <aside class="editor-pane editor-pane-toc">
          <div class="editor-pane-header">
            <span class="editor-pane-title">目录</span>
          </div>
          <div class="editor-pane-body editor-toc-host">
            ${getTocMarkup()}
          </div>
        </aside>
        <div class="editor-splitter editor-splitter-toc" role="separator" aria-orientation="vertical">
          <button class="editor-splitter-toggle" type="button" data-action="toggle-toc" aria-expanded="${String(!state.tocCollapsed)}">
            ${state.tocCollapsed ? ">" : "<"}
          </button>
        </div>
        <section class="editor-pane editor-pane-content">
          <div class="editor-fields">
            <label class="editor-field">
              <span class="editor-field-label">标题</span>
              <input class="editor-input" type="text" id="editor-title" value="${escapeHtml(state.title)}" />
            </label>
            <label class="editor-field">
              <span class="editor-field-label">描述</span>
              <textarea class="editor-textarea editor-textarea-description" id="editor-description">${escapeHtml(state.description)}</textarea>
            </label>
            <label class="editor-field editor-field-body">
              <span class="editor-field-label">正文</span>
              <textarea class="editor-textarea editor-textarea-body" id="editor-body">${escapeHtml(state.body)}</textarea>
            </label>
          </div>
        </section>
        <div class="editor-splitter editor-splitter-preview" role="separator" aria-orientation="vertical">
          <button class="editor-splitter-toggle" type="button" data-action="toggle-preview" aria-expanded="${String(!state.previewCollapsed)}">
            ${state.previewCollapsed ? "<" : ">"}
          </button>
        </div>
        <aside class="editor-pane editor-pane-preview">
          <div class="editor-pane-header">
            <span class="editor-pane-title">预览</span>
          </div>
          <div class="editor-pane-body editor-preview-host">
            <iframe class="editor-preview-frame" title="文章预览"></iframe>
          </div>
        </aside>
      </main>
    </div>
  `;

  bindToolbar();
  bindPaneToggles();
  bindSplitterDrag();
  bindTreeToggles();
  bindTreePostOpeners();
  bindTocToggles();
  bindEditorFields();
  updatePreview();
}

function updatePreview(): void {
  const frame = app.querySelector<HTMLIFrameElement>(".editor-preview-frame");
  if (!frame) {
    return;
  }

  frame.srcdoc = buildPreviewDocument({
    title: state.title,
    description: state.description,
    body: state.body,
    currentFilePath: state.currentFilePath
  });
}

function updateDraftViews(): void {
  const treeHost = app.querySelector<HTMLElement>(".editor-tree-host");
  const tocHost = app.querySelector<HTMLElement>(".editor-toc-host");

  if (treeHost) {
    treeHost.innerHTML = getArticleTreeMarkup();
    bindTreeToggles();
    bindTreePostOpeners();
  }

  if (tocHost) {
    tocHost.innerHTML = getTocMarkup();
    bindTocToggles();
  }

  updatePreview();
}

function bindToolbar(): void {
  const toggleButton = app.querySelector<HTMLButtonElement>("[data-action='toggle-toolbar']");
  toggleButton?.addEventListener("click", function () {
    state.toolbarCollapsed = !state.toolbarCollapsed;
    render();
  });

  const saveButton = app.querySelector<HTMLButtonElement>("[data-action='save-post']");
  saveButton?.addEventListener("click", function () {
    void savePost();
  });
}

function bindPaneToggles(): void {
  const articlesButton = app.querySelector<HTMLButtonElement>("[data-action='toggle-articles']");
  const tocButton = app.querySelector<HTMLButtonElement>("[data-action='toggle-toc']");
  const previewButton = app.querySelector<HTMLButtonElement>("[data-action='toggle-preview']");

  articlesButton?.addEventListener("click", function () {
    state.articlesCollapsed = !state.articlesCollapsed;
    persistLayoutState();
    applyLayoutToDom();
  });

  tocButton?.addEventListener("click", function () {
    state.tocCollapsed = !state.tocCollapsed;
    persistLayoutState();
    applyLayoutToDom();
  });

  previewButton?.addEventListener("click", function () {
    state.previewCollapsed = !state.previewCollapsed;
    persistLayoutState();
    applyLayoutToDom();
  });
}

function startSplitterDrag(onMove: (event: MouseEvent) => void): void {
  document.body.classList.add("editor-resizing");

  function handleMove(event: MouseEvent): void {
    onMove(event);
  }

  function handleUp(): void {
    document.body.classList.remove("editor-resizing");
    window.removeEventListener("mousemove", handleMove);
    window.removeEventListener("mouseup", handleUp);
  }

  window.addEventListener("mousemove", handleMove);
  window.addEventListener("mouseup", handleUp);
}

function bindSplitterDrag(): void {
  const articleSplitter = app.querySelector<HTMLElement>(".editor-splitter-tree");
  const articleToggle = app.querySelector<HTMLElement>("[data-action='toggle-articles']");
  const tocSplitter = app.querySelector<HTMLElement>(".editor-splitter-toc");
  const tocToggle = app.querySelector<HTMLElement>("[data-action='toggle-toc']");
  const previewSplitter = app.querySelector<HTMLElement>(".editor-splitter-preview");
  const previewToggle = app.querySelector<HTMLElement>("[data-action='toggle-preview']");

  articleSplitter?.addEventListener("mousedown", function (event) {
    if (event.button !== 0 || event.target === articleToggle) {
      return;
    }
    event.preventDefault();

    if (state.articlesCollapsed) {
      state.articlesCollapsed = false;
      persistLayoutState();
      applyLayoutToDom();
    }

    const startX = event.clientX;
    const startWidth = state.articlesWidth;
    startSplitterDrag(function (moveEvent) {
      state.articlesWidth = clampArticlesWidth(startWidth + (moveEvent.clientX - startX));
      persistLayoutState();
      applyLayoutToDom();
    });
  });

  tocSplitter?.addEventListener("mousedown", function (event) {
    if (event.button !== 0 || event.target === tocToggle) {
      return;
    }
    event.preventDefault();

    if (state.tocCollapsed) {
      state.tocCollapsed = false;
      persistLayoutState();
      applyLayoutToDom();
    }

    const startX = event.clientX;
    const startWidth = state.tocWidth;
    startSplitterDrag(function (moveEvent) {
      state.tocWidth = clampTocWidth(startWidth + (moveEvent.clientX - startX));
      persistLayoutState();
      applyLayoutToDom();
    });
  });

  previewSplitter?.addEventListener("mousedown", function (event) {
    if (event.button !== 0 || event.target === previewToggle) {
      return;
    }
    event.preventDefault();

    if (state.previewCollapsed) {
      state.previewCollapsed = false;
      persistLayoutState();
      applyLayoutToDom();
    }

    const startX = event.clientX;
    const startWidth = state.previewWidth;
    startSplitterDrag(function (moveEvent) {
      state.previewWidth = clampPreviewWidth(startWidth - (moveEvent.clientX - startX));
      persistLayoutState();
      applyLayoutToDom();
    });
  });
}

function bindTreeToggles(): void {
  const buttons = app.querySelectorAll<HTMLButtonElement>(".content-tree-toggle");
  for (const button of buttons) {
    button.addEventListener("click", function () {
      const item = button.closest(".content-tree-item");
      if (!item) {
        return;
      }

      const collapsed = item.classList.toggle("is-collapsed");
      button.setAttribute("aria-expanded", String(!collapsed));
      button.setAttribute("aria-label", collapsed ? "展开子节点" : "收起子节点");
    });
  }
}

function bindTreePostOpeners(): void {
  const buttons = app.querySelectorAll<HTMLButtonElement>("[data-switch-post-slug]");
  for (const button of buttons) {
    button.addEventListener("click", function () {
      const slug = button.dataset.switchPostSlug;
      if (!slug || slug === state.currentSlug) {
        return;
      }

      void openPostInCurrentEditor(slug);
    });
  }
}

function getTocItemDepth(itemEl: Element): number {
  const raw = itemEl.getAttribute("data-depth");
  const depth = Number.parseInt(raw || "0", 10);
  return Number.isFinite(depth) ? depth : 0;
}

function refreshTocVisibility(tocListEl: HTMLElement): void {
  const items = Array.from(tocListEl.querySelectorAll<HTMLElement>(".editor-toc-item"));
  const collapsedStack: number[] = [];

  for (const itemEl of items) {
    const depth = getTocItemDepth(itemEl);

    while (collapsedStack.length > 0 && depth <= collapsedStack[collapsedStack.length - 1]) {
      collapsedStack.pop();
    }

    const hidden = collapsedStack.length > 0;
    itemEl.classList.toggle("editor-toc-item-hidden", hidden);

    if (!hidden && itemEl.getAttribute("data-collapsed") === "1") {
      collapsedStack.push(depth);
    }
  }
}

function bindTocToggles(): void {
  const tocList = app.querySelector<HTMLElement>(".editor-toc-list");
  if (!tocList) {
    return;
  }

  const buttons = tocList.querySelectorAll<HTMLButtonElement>(".editor-toc-toggle-btn");
  for (const button of buttons) {
    if (button.dataset.bound === "1") {
      continue;
    }

    button.dataset.bound = "1";
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();

      const itemEl = button.closest<HTMLElement>(".editor-toc-item");
      if (!itemEl || !itemEl.classList.contains("has-children")) {
        return;
      }

      const nextCollapsed = itemEl.getAttribute("data-collapsed") !== "1";
      itemEl.setAttribute("data-collapsed", nextCollapsed ? "1" : "0");
      button.setAttribute("aria-expanded", String(!nextCollapsed));
      button.setAttribute("aria-label", nextCollapsed ? "展开子标题" : "收起子标题");
      refreshTocVisibility(tocList);
    });
  }

  refreshTocVisibility(tocList);
}

function bindEditorFields(): void {
  const titleInput = app.querySelector<HTMLInputElement>("#editor-title");
  const descriptionInput = app.querySelector<HTMLTextAreaElement>("#editor-description");
  const bodyInput = app.querySelector<HTMLTextAreaElement>("#editor-body");

  titleInput?.addEventListener("input", function () {
    state.title = titleInput.value;
    state.saveMessage = "";
    updateDraftViews();
  });

  descriptionInput?.addEventListener("input", function () {
    state.description = descriptionInput.value;
    state.saveMessage = "";
    updateDraftViews();
  });

  bodyInput?.addEventListener("input", function () {
    state.body = bodyInput.value;
    state.saveMessage = "";
    updateDraftViews();
  });
}

function resolvePlacement(): { category: string; parent: string } {
  if (state.currentSlug) {
    return {
      category: state.currentCategory,
      parent: state.currentParent
    };
  }

  if (state.targetKind === "category") {
    return {
      category: state.targetId,
      parent: ""
    };
  }

  if (state.targetKind === "post") {
    const parentPost = state.snapshot.posts.find((post) => post.slug === state.targetId);
    return {
      category: parentPost?.category || "",
      parent: state.targetId
    };
  }

  return {
    category: "",
    parent: ""
  };
}

async function refreshRepository(): Promise<void> {
  if (!state.session) {
    state.snapshot = getEmptySnapshot();
    return;
  }

  state.snapshot = await loadRepositorySnapshot(state.session.projectPath);
}

function applyDocument(document: PostDocument): void {
  state.mode = "edit";
  state.routeSlug = document.slug;
  state.title = document.title;
  state.description = document.description;
  state.body = document.body;
  state.currentSlug = document.slug;
  state.currentFilePath = document.filePath;
  state.currentCategory = document.category;
  state.currentParent = document.parent;
  state.currentDate = document.date || new Date().toISOString().slice(0, 10);
  state.currentOrder = document.order;
}

async function loadExistingPostBySlug(slug: string): Promise<void> {
  const matchedPost = state.snapshot.posts.find((post) => post.slug === slug);
  if (!matchedPost) {
    throw new Error(`未找到文章: ${slug}`);
  }

  const document = await loadPostDocument(matchedPost.filePath);
  applyDocument(document);
}

async function openPostInCurrentEditor(slug: string): Promise<void> {
  if (!state.session) {
    return;
  }

  state.loading = true;
  state.error = "";
  state.saveMessage = "";
  render();

  try {
    await loadExistingPostBySlug(slug);
    syncEditorUrl(slug);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
    render();
  }
}

async function savePost(): Promise<void> {
  if (!state.session) {
    return;
  }

  const title = state.title.trim();
  if (!title) {
    window.alert("标题不能为空。");
    return;
  }

  if (!isTauri()) {
    window.alert("保存功能仅在 Tauri 桌面模式下可用。");
    return;
  }

  const placement = resolvePlacement();
  const request: SavePostRequest = {
    projectPath: state.session.projectPath,
    title,
    description: state.description,
    body: state.body,
    category: placement.category,
    parent: placement.parent,
    existingSlug: state.currentSlug,
    existingFilePath: state.currentFilePath,
    date: state.currentDate,
    order: state.currentOrder
  };

  state.saving = true;
  state.error = "";
  state.saveMessage = "";
  render();

  try {
    const savedPost = await invoke<PostRecord>("save_post", { request });
    state.currentSlug = savedPost.slug;
    state.currentFilePath = savedPost.filePath;
    state.currentCategory = savedPost.category;
    state.currentParent = savedPost.parent;
    state.currentDate = savedPost.date;
    state.currentOrder = savedPost.order;
    state.mode = "edit";
    state.routeSlug = savedPost.slug;
    syncEditorUrl(savedPost.slug);
    await refreshRepository();
    state.saveMessage = "已保存";
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.saving = false;
    render();
  }
}

async function bootstrap(): Promise<void> {
  render();

  if (!state.session) {
    return;
  }

  state.loading = true;
  render();

  try {
    await refreshRepository();
    state.error = "";

    if (state.mode === "edit" && state.routeSlug) {
      await loadExistingPostBySlug(state.routeSlug);
    }
  } catch (error) {
    state.snapshot = getEmptySnapshot();
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
    render();
  }
}

void bootstrap();
