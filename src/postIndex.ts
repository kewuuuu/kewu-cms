export type CategoryDefinition = {
  id: string;
  title: string;
  description: string;
  order: number;
};

export type PostRecord = {
  title: string;
  description: string;
  date: string;
  slug: string;
  category: string;
  parent: string;
  order: number;
  fileName: string;
  filePath: string;
  updatedAtMs: number;
};

export type RepositorySnapshot = {
  categories: CategoryDefinition[];
  posts: PostRecord[];
};

export type ViewMode = "tree" | "flat";
export type SortField = "title" | "updatedAt";
export type SortDirection = "asc" | "desc";

export type TreeNode = {
  uid: string;
  id: string;
  kind: "category" | "post";
  title: string;
  description: string;
  date: string;
  slug: string;
  category: string;
  parent: string;
  order: number;
  fileName: string;
  filePath: string;
  updatedAtMs: number;
  children: TreeNode[];
};

export type PathSegment = {
  kind: "category" | "post";
  title: string;
};

export type FlatPostItem = {
  post: PostRecord;
  pathSegments: PathSegment[];
};

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "zh-CN-u-co-pinyin");
}

function getNodeSortValue(node: TreeNode, sortField: SortField): string | number {
  if (sortField === "updatedAt") {
    return node.updatedAtMs;
  }

  return node.title;
}

function getPostSortValue(post: PostRecord, sortField: SortField): string | number {
  return sortField === "updatedAt" ? post.updatedAtMs : post.title;
}

function compareNodeValues(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  return compareText(String(left), String(right));
}

function applyDirection(result: number, direction: SortDirection): number {
  return direction === "asc" ? result : -result;
}

function compareTreeNodes(left: TreeNode, right: TreeNode, sortField: SortField, direction: SortDirection): number {
  const primary = compareNodeValues(getNodeSortValue(left, sortField), getNodeSortValue(right, sortField));
  if (primary !== 0) {
    return applyDirection(primary, direction);
  }

  if (left.kind !== right.kind) {
    return left.kind === "category" ? -1 : 1;
  }

  const orderResult = left.order - right.order;
  if (orderResult !== 0) {
    return orderResult;
  }

  return compareText(left.title, right.title);
}

function comparePosts(left: PostRecord, right: PostRecord, sortField: SortField, direction: SortDirection): number {
  const primary = compareNodeValues(getPostSortValue(left, sortField), getPostSortValue(right, sortField));
  if (primary !== 0) {
    return applyDirection(primary, direction);
  }

  const orderResult = left.order - right.order;
  if (orderResult !== 0) {
    return orderResult;
  }

  return compareText(left.title, right.title);
}

function computeCategoryUpdatedAt(node: TreeNode): number {
  if (node.kind === "post") {
    return node.updatedAtMs;
  }

  let latest = node.updatedAtMs;
  for (const child of node.children) {
    const childUpdatedAt = computeCategoryUpdatedAt(child);
    if (childUpdatedAt > latest) {
      latest = childUpdatedAt;
    }
  }

  node.updatedAtMs = latest;
  return latest;
}

function sortTree(nodes: TreeNode[], sortField: SortField, direction: SortDirection): void {
  nodes.sort(function (left, right) {
    return compareTreeNodes(left, right, sortField, direction);
  });

  for (const node of nodes) {
    if (node.children.length > 0) {
      sortTree(node.children, sortField, direction);
    }
  }
}

export function getEmptySnapshot(): RepositorySnapshot {
  return {
    categories: [],
    posts: []
  };
}

export function buildTree(snapshot: RepositorySnapshot, sortField: SortField, direction: SortDirection): TreeNode[] {
  const roots: TreeNode[] = [];
  const categoryNodes = new Map<string, TreeNode>();
  const postNodes = new Map<string, TreeNode>();

  for (const category of snapshot.categories) {
    const categoryNode: TreeNode = {
      uid: `category:${category.id}`,
      id: category.id,
      kind: "category",
      title: category.title,
      description: category.description,
      date: "",
      slug: "",
      category: "",
      parent: "",
      order: category.order,
      fileName: category.id,
      filePath: "",
      updatedAtMs: 0,
      children: []
    };

    categoryNodes.set(category.id, categoryNode);
    roots.push(categoryNode);
  }

  for (const post of snapshot.posts) {
    postNodes.set(post.slug, {
      uid: `post:${post.slug}`,
      id: post.slug,
      kind: "post",
      title: post.title,
      description: post.description,
      date: post.date,
      slug: post.slug,
      category: post.category,
      parent: post.parent,
      order: post.order,
      fileName: post.fileName,
      filePath: post.filePath,
      updatedAtMs: post.updatedAtMs,
      children: []
    });
  }

  for (const post of snapshot.posts) {
    const node = postNodes.get(post.slug);
    if (!node) {
      continue;
    }

    const parentNode = post.parent ? postNodes.get(post.parent) : null;
    if (parentNode) {
      parentNode.children.push(node);
      continue;
    }

    const categoryNode = post.category ? categoryNodes.get(post.category) : null;
    if (categoryNode) {
      categoryNode.children.push(node);
      continue;
    }

    roots.push(node);
  }

  for (const root of roots) {
    computeCategoryUpdatedAt(root);
  }

  sortTree(roots, sortField, direction);
  return roots;
}

function buildPathSegments(post: PostRecord, categoriesById: Map<string, CategoryDefinition>, postsById: Map<string, PostRecord>): PathSegment[] {
  const segments: PathSegment[] = [];

  if (post.category) {
    const category = categoriesById.get(post.category);
    if (category) {
      segments.push({
        kind: "category",
        title: category.title
      });
    }
  }

  const ancestors: PathSegment[] = [];
  const visited = new Set<string>();
  let currentParentId = post.parent;

  while (currentParentId) {
    if (visited.has(currentParentId)) {
      break;
    }
    visited.add(currentParentId);

    const parentPost = postsById.get(currentParentId);
    if (!parentPost) {
      break;
    }

    ancestors.unshift({
      kind: "post",
      title: parentPost.title
    });

    currentParentId = parentPost.parent;
  }

  return segments.concat(ancestors);
}

export function buildFlatPosts(snapshot: RepositorySnapshot, sortField: SortField, direction: SortDirection): FlatPostItem[] {
  const categoriesById = new Map<string, CategoryDefinition>();
  const postsById = new Map<string, PostRecord>();

  for (const category of snapshot.categories) {
    categoriesById.set(category.id, category);
  }

  for (const post of snapshot.posts) {
    postsById.set(post.slug, post);
  }

  const posts = [...snapshot.posts];
  posts.sort(function (left, right) {
    return comparePosts(left, right, sortField, direction);
  });

  return posts.map(function (post) {
    return {
      post,
      pathSegments: buildPathSegments(post, categoriesById, postsById)
    };
  });
}

export function formatUpdatedAt(updatedAtMs: number): string {
  if (!updatedAtMs) {
    return "未知时间";
  }

  const date = new Date(updatedAtMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}
