import "./style.css";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  buildFlatPosts,
  buildTree,
  formatUpdatedAt,
  getEmptySnapshot,
  type RepositorySnapshot,
  type SortDirection,
  type SortField,
  type TreeNode,
  type ViewMode
} from "./postIndex";

type SessionState = {
  projectPath: string;
};

type AppState = {
  session: SessionState | null;
  snapshot: RepositorySnapshot;
  loading: boolean;
  error: string;
  viewMode: ViewMode;
  sortField: SortField;
  sortDirection: SortDirection;
};

const STORAGE_KEY = "kewu-cms:session";

const state: AppState = {
  session: readSession(),
  snapshot: getEmptySnapshot(),
  loading: false,
  error: "",
  viewMode: "tree",
  sortField: "title",
  sortDirection: "asc"
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found.");
}

function readSession(): SessionState | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as SessionState;
    if (!parsed.projectPath) {
      return null;
    }
    return parsed;
  } catch (_error) {
    return null;
  }
}

function writeSession(session: SessionState | null): void {
  if (!session) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function getFolderName(projectPath: string): string {
  const normalized = projectPath.trim().replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : normalized;
}

function isValidRepoPath(projectPath: string): boolean {
  return projectPath.trim().length > 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getProjectDisplayMarkup(projectPath: string): string {
  const folderName = getFolderName(projectPath);
  const safePath = escapeHtml(projectPath);
  const safeFolderName = escapeHtml(folderName);

  return `
    <div class="project-pill" title="${safePath}">
      <button class="project-pill-button" type="button" aria-label="项目操作" aria-expanded="false">
        <span class="project-pill-text">${safeFolderName}</span>
      </button>
      <div class="project-menu" hidden>
        <button class="project-menu-item" type="button" data-action="logout">退出</button>
      </div>
    </div>
  `;
}

function getToolbarMarkup(): string {
  const viewModeLabel = state.viewMode === "tree" ? "结构显示" : "顺序显示";
  const sortFieldLabel = state.sortField === "title" ? "名字排序" : "最后更新时间排序";
  const sortDirectionLabel = state.sortDirection === "asc" ? "正序" : "倒序";

  return `
    <div class="content-toolbar">
      <button class="content-toolbar-button" type="button" data-action="toggle-view">${viewModeLabel}</button>
      <button class="content-toolbar-button" type="button" data-action="toggle-sort-field">${sortFieldLabel}</button>
      <button class="content-toolbar-button" type="button" data-action="toggle-sort-direction">${sortDirectionLabel}</button>
      <span class="content-toolbar-spacer"></span>
      <button class="content-toolbar-button content-toolbar-button-primary" type="button" data-action="open-create-editor">+</button>
    </div>
  `;
}

function getPostTitleMarkup(node: TreeNode): string {
  if (node.kind !== "post") {
    return `<span class="content-tree-label">${escapeHtml(node.title)}</span>`;
  }

  return `
    <button class="content-tree-open" type="button" data-open-post-slug="${escapeHtml(node.slug)}">
      <span class="content-tree-label">${escapeHtml(node.title)}</span>
    </button>
  `;
}

function renderTreeNodes(nodes: TreeNode[]): string {
  if (nodes.length === 0) {
    return "";
  }

  return `
    <ol class="content-tree-list">
      ${nodes
        .map(function (node) {
          const hasChildren = node.children.length > 0;
          const description = node.description ? `<p class="content-tree-description">${escapeHtml(node.description)}</p>` : "";
          const metaMarkup = node.kind === "post" && node.updatedAtMs
            ? `<p class="content-tree-meta">${escapeHtml(formatUpdatedAt(node.updatedAtMs))}</p>`
            : "";

          return `
            <li class="content-tree-item content-tree-item-${node.kind}${hasChildren ? " has-children" : ""}">
              ${hasChildren
                ? '<button class="content-tree-toggle" type="button" aria-expanded="true" aria-label="收起子节点"></button>'
                : '<span class="content-tree-toggle-placeholder" aria-hidden="true"></span>'}
              <div class="content-tree-entry">
                <div class="content-tree-title-row content-tree-title-row-${node.kind}">
                  ${getPostTitleMarkup(node)}
                </div>
                ${description}
                ${metaMarkup}
              </div>
              ${hasChildren ? renderTreeNodes(node.children) : ""}
            </li>
          `;
        })
        .join("")}
    </ol>
  `;
}

function getTreeMarkup(snapshot: RepositorySnapshot): string {
  const nodes = buildTree(snapshot, state.sortField, state.sortDirection);
  if (nodes.length === 0) {
    return `<p class="empty-state">当前没有文章。</p>`;
  }

  return `
    <section class="content-tree-panel">
      ${renderTreeNodes(nodes)}
    </section>
  `;
}

function getFlatListMarkup(snapshot: RepositorySnapshot): string {
  const items = buildFlatPosts(snapshot, state.sortField, state.sortDirection);
  if (items.length === 0) {
    return `<p class="empty-state">当前没有文章。</p>`;
  }

  return `
    <ul class="flat-post-list">
      ${items
        .map(function (item) {
          const pathMarkup = item.pathSegments.length > 0
            ? `
              <div class="flat-post-path">
                ${item.pathSegments
                  .map(function (segment) {
                    return `<span class="flat-post-path-segment flat-post-path-segment-${segment.kind}">${escapeHtml(segment.title)}</span>`;
                  })
                  .join('<span class="flat-post-path-separator">/</span>')}
              </div>
            `
            : '<div class="flat-post-path flat-post-path-empty">根节点</div>';

          return `
            <li class="flat-post-item">
              <button class="flat-post-open" type="button" data-open-post-slug="${escapeHtml(item.post.slug)}">
                <span class="flat-post-title">${escapeHtml(item.post.title)}</span>
              </button>
              ${pathMarkup}
              <div class="flat-post-meta">
                <span>${escapeHtml(item.post.fileName)}</span>
                <span>${escapeHtml(formatUpdatedAt(item.post.updatedAtMs))}</span>
              </div>
            </li>
          `;
        })
        .join("")}
    </ul>
  `;
}

function getContentMarkup(): string {
  if (state.loading) {
    return `
      <section class="content-panel">
        ${getToolbarMarkup()}
        <p class="empty-state">正在加载文章仓库...</p>
      </section>
    `;
  }

  if (state.error) {
    return `
      <section class="content-panel">
        ${getToolbarMarkup()}
        <p class="error-state">${escapeHtml(state.error)}</p>
      </section>
    `;
  }

  return `
    <section class="content-panel">
      ${getToolbarMarkup()}
      ${state.viewMode === "tree" ? getTreeMarkup(state.snapshot) : getFlatListMarkup(state.snapshot)}
    </section>
  `;
}

function render(): void {
  const projectHostClass = state.session ? "project-host project-host-compact" : "project-host project-host-login";
  const projectArea = state.session
    ? getProjectDisplayMarkup(state.session.projectPath)
    : `
      <div class="project-login">
        <button class="picker-button" type="button">选择</button>
        <input
          class="path-input"
          type="text"
          placeholder="请输入文章仓库完整路径"
          spellcheck="false"
          autocomplete="off"
        />
        <button class="confirm-button" type="button">确定</button>
      </div>
    `;

  const mainContent = state.session
    ? getContentMarkup()
    : `
      <section class="content-panel content-panel-empty">
        <h1 class="page-title">请选择文章本地仓库地址</h1>
      </section>
    `;

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">KEWU CMS</div>
        <div class="${projectHostClass}">
          ${projectArea}
        </div>
      </header>
      <main class="main-area">
        ${mainContent}
      </main>
    </div>
  `;

  if (state.session) {
    bindProjectMenu();
    bindToolbar();
    bindPostOpeners();
    if (state.viewMode === "tree") {
      bindContentTree();
    }
  } else {
    bindLoginForm();
  }

  updateOverflowState();
}

async function chooseProjectPath(currentPath: string): Promise<string | null> {
  if (isTauri()) {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      title: "选择文章仓库目录",
      defaultPath: currentPath || undefined
    });

    return typeof selectedPath === "string" ? selectedPath : null;
  }

  return window.prompt("请输入文章仓库完整路径", currentPath);
}

async function loadRepositorySnapshot(projectPath: string): Promise<RepositorySnapshot> {
  if (!isTauri()) {
    return getEmptySnapshot();
  }

  return invoke<RepositorySnapshot>("load_repository_snapshot", { projectPath });
}

function buildCreateEditorUrl(): string {
  const url = new URL("/editor.html", window.location.origin);
  url.searchParams.set("mode", "new");
  url.searchParams.set("targetKind", "root");
  return url.toString();
}

function buildPostEditorUrl(slug: string): string {
  const url = new URL("/editor.html", window.location.origin);
  url.searchParams.set("mode", "edit");
  url.searchParams.set("slug", slug);
  return url.toString();
}

async function openEditorWindow(editorUrl: string): Promise<void> {
  if (isTauri()) {
    const label = `editor-${Date.now()}`;
    const editorWindow = new WebviewWindow(label, {
      title: "内容编辑",
      url: editorUrl,
      width: 1400,
      height: 900,
      resizable: true
    });

    editorWindow.once("tauri://error", function (event) {
      console.error("Failed to create editor window", event);
    });
    return;
  }

  window.open(editorUrl, "_blank", "noopener,noreferrer");
}

async function openCreateEditor(): Promise<void> {
  await openEditorWindow(buildCreateEditorUrl());
}

async function openExistingPostEditor(slug: string): Promise<void> {
  await openEditorWindow(buildPostEditorUrl(slug));
}

async function refreshRepository(): Promise<void> {
  if (!state.session) {
    state.snapshot = getEmptySnapshot();
    state.loading = false;
    state.error = "";
    render();
    return;
  }

  state.loading = true;
  state.error = "";
  render();

  try {
    state.snapshot = await loadRepositorySnapshot(state.session.projectPath);
  } catch (error) {
    state.snapshot = getEmptySnapshot();
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
    render();
  }
}

function bindLoginForm(): void {
  const pickerButton = app.querySelector<HTMLButtonElement>(".picker-button");
  const input = app.querySelector<HTMLInputElement>(".path-input");
  const confirmButton = app.querySelector<HTMLButtonElement>(".confirm-button");

  if (!pickerButton || !input || !confirmButton) {
    return;
  }

  pickerButton.addEventListener("click", async function () {
    const nextPath = await chooseProjectPath(input.value.trim());
    if (!nextPath) {
      return;
    }

    input.value = nextPath;
    input.title = nextPath;
  });

  input.addEventListener("input", function () {
    input.title = input.value;
  });

  confirmButton.addEventListener("click", async function () {
    const nextPath = input.value.trim();
    if (!isValidRepoPath(nextPath)) {
      window.alert("请输入文章仓库完整路径。");
      return;
    }

    state.session = { projectPath: nextPath };
    writeSession(state.session);
    await refreshRepository();
  });
}

function bindProjectMenu(): void {
  const pillButton = app.querySelector<HTMLButtonElement>(".project-pill-button");
  const menu = app.querySelector<HTMLDivElement>(".project-menu");
  const logoutButton = app.querySelector<HTMLButtonElement>("[data-action='logout']");

  if (!pillButton || !menu || !logoutButton) {
    return;
  }

  function closeMenu(): void {
    menu.hidden = true;
    pillButton.setAttribute("aria-expanded", "false");
  }

  pillButton.addEventListener("click", function (event) {
    event.stopPropagation();
    const isOpen = !menu.hidden;
    menu.hidden = isOpen;
    pillButton.setAttribute("aria-expanded", String(!isOpen));
  });

  logoutButton.addEventListener("click", function () {
    state.session = null;
    state.snapshot = getEmptySnapshot();
    state.loading = false;
    state.error = "";
    writeSession(null);
    render();
  });

  window.addEventListener("click", function (event) {
    if (!menu.hidden && !menu.contains(event.target as Node) && event.target !== pillButton) {
      closeMenu();
    }
  });
}

function bindToolbar(): void {
  const viewButton = app.querySelector<HTMLButtonElement>("[data-action='toggle-view']");
  const sortFieldButton = app.querySelector<HTMLButtonElement>("[data-action='toggle-sort-field']");
  const sortDirectionButton = app.querySelector<HTMLButtonElement>("[data-action='toggle-sort-direction']");

  viewButton?.addEventListener("click", function () {
    state.viewMode = state.viewMode === "tree" ? "flat" : "tree";
    render();
  });

  sortFieldButton?.addEventListener("click", function () {
    state.sortField = state.sortField === "title" ? "updatedAt" : "title";
    render();
  });

  sortDirectionButton?.addEventListener("click", function () {
    state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
    render();
  });

  const createButton = app.querySelector<HTMLButtonElement>("[data-action='open-create-editor']");
  createButton?.addEventListener("click", function () {
    void openCreateEditor();
  });
}

function bindPostOpeners(): void {
  const buttons = app.querySelectorAll<HTMLButtonElement>("[data-open-post-slug]");
  for (const button of buttons) {
    button.addEventListener("click", function () {
      const slug = button.dataset.openPostSlug;
      if (!slug) {
        return;
      }

      void openExistingPostEditor(slug);
    });
  }
}

function bindContentTree(): void {
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

function updateOverflowState(): void {
  const text = app.querySelector<HTMLElement>(".project-pill-text");
  const pill = app.querySelector<HTMLElement>(".project-pill");
  if (!text || !pill) {
    return;
  }

  const overflowing = text.scrollWidth > text.clientWidth;
  pill.classList.toggle("is-overflow", overflowing);
}

window.addEventListener("resize", updateOverflowState);

render();
void refreshRepository();
