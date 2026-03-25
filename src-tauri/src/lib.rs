use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CategoryDefinition {
  id: String,
  title: String,
  description: String,
  order: i32,
}

#[derive(Debug, Deserialize)]
struct RawCategoryDefinition {
  id: String,
  title: Option<String>,
  description: Option<String>,
  order: Option<i32>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PostRecord {
  title: String,
  description: String,
  date: String,
  slug: String,
  category: String,
  parent: String,
  order: i32,
  file_name: String,
  file_path: String,
  updated_at_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositorySnapshot {
  categories: Vec<CategoryDefinition>,
  posts: Vec<PostRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PostDocument {
  title: String,
  description: String,
  body: String,
  date: String,
  slug: String,
  category: String,
  parent: String,
  order: i32,
  file_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavePostRequest {
  project_path: String,
  title: String,
  description: String,
  body: String,
  category: String,
  parent: String,
  existing_slug: String,
  existing_file_path: String,
  date: String,
  order: i32,
}

fn split_front_matter(raw: &str) -> (HashMap<String, String>, String) {
  let mut map = HashMap::new();
  let normalized = raw.replace("\r\n", "\n");

  if !normalized.starts_with("---\n") {
    return (map, normalized);
  }

  let mut parts = normalized.splitn(3, "---\n");
  let _ = parts.next();
  let Some(front_matter) = parts.next() else {
    return (map, normalized);
  };
  let body = parts.next().unwrap_or_default().to_string();

  for line in front_matter.lines() {
    let Some((key, value)) = line.split_once(':') else {
      continue;
    };

    let key = key.trim();
    let value = value.trim();
    if !key.is_empty() {
      map.insert(key.to_string(), value.to_string());
    }
  }

  (map, body)
}

fn parse_front_matter(raw: &str) -> HashMap<String, String> {
  split_front_matter(raw).0
}

fn parse_order(value: Option<&String>, fallback: i32) -> i32 {
  value
    .and_then(|value| value.parse::<i32>().ok())
    .unwrap_or(fallback)
}

fn read_categories(project_path: &Path) -> Result<Vec<CategoryDefinition>, String> {
  let categories_path = project_path.join("postCategories.json");
  if !categories_path.exists() {
    return Ok(Vec::new());
  }

  let raw = fs::read_to_string(&categories_path)
    .map_err(|error| format!("读取分类文件失败: {} ({})", categories_path.display(), error))?;

  let parsed: Vec<RawCategoryDefinition> = serde_json::from_str(&raw)
    .map_err(|error| format!("解析分类文件失败: {} ({})", categories_path.display(), error))?;

  Ok(parsed
    .into_iter()
    .map(|category| CategoryDefinition {
      title: category.title.clone().unwrap_or_else(|| category.id.clone()),
      description: category.description.unwrap_or_default(),
      order: category.order.unwrap_or(999),
      id: category.id,
    })
    .collect())
}

fn derive_slug(markdown_path: &Path, posts_root: &Path) -> String {
  let relative_path = markdown_path.strip_prefix(posts_root).unwrap_or(markdown_path);
  let first_segment = relative_path
    .components()
    .next()
    .map(|component| component.as_os_str().to_string_lossy().to_string());

  if let Some(segment) = first_segment {
    if !segment.is_empty() {
      return segment;
    }
  }

  markdown_path
    .file_stem()
    .map(|stem| stem.to_string_lossy().to_string())
    .unwrap_or_else(|| markdown_path.display().to_string())
}

fn get_updated_at_ms(markdown_path: &Path) -> u64 {
  fs::metadata(markdown_path)
    .ok()
    .and_then(|metadata| metadata.modified().ok())
    .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
    .map(|duration| duration.as_millis() as u64)
    .unwrap_or(0)
}

fn read_posts(project_path: &Path) -> Result<Vec<PostRecord>, String> {
  let posts_root = project_path.join("posts");
  if !posts_root.exists() {
    return Ok(Vec::new());
  }

  let mut posts = Vec::new();

  for entry in WalkDir::new(&posts_root).into_iter().filter_map(Result::ok) {
    let path = entry.path();
    if !path.is_file() {
      continue;
    }

    let Some(extension) = path.extension() else {
      continue;
    };
    if extension.to_string_lossy().to_ascii_lowercase() != "md" {
      continue;
    }

    let raw = fs::read_to_string(path)
      .map_err(|error| format!("读取文章失败: {} ({})", path.display(), error))?;

    let front_matter = parse_front_matter(&raw);
    let file_name = path
      .file_stem()
      .map(|stem| stem.to_string_lossy().to_string())
      .unwrap_or_else(|| derive_slug(path, &posts_root));
    let slug = front_matter
      .get("postId")
      .cloned()
      .or_else(|| front_matter.get("slug").cloned())
      .unwrap_or_else(|| derive_slug(path, &posts_root));

    posts.push(PostRecord {
      title: front_matter
        .get("title")
        .cloned()
        .unwrap_or_else(|| slug.clone()),
      description: front_matter.get("description").cloned().unwrap_or_default(),
      date: front_matter.get("date").cloned().unwrap_or_default(),
      slug,
      category: front_matter.get("category").cloned().unwrap_or_default(),
      parent: front_matter.get("parent").cloned().unwrap_or_default(),
      order: parse_order(front_matter.get("order"), 999),
      file_name,
      file_path: path.to_string_lossy().to_string(),
      updated_at_ms: get_updated_at_ms(path),
    });
  }

  Ok(posts)
}

fn sanitize_post_stem(title: &str) -> String {
  let invalid_chars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
  let mut result = String::new();
  let mut previous_was_space = false;

  for ch in title.trim().chars() {
    if ch.is_control() || invalid_chars.contains(&ch) {
      continue;
    }

    if ch.is_whitespace() {
      if !result.is_empty() && !previous_was_space {
        result.push(' ');
        previous_was_space = true;
      }
      continue;
    }

    result.push(ch);
    previous_was_space = false;
  }

  let trimmed = result.trim().trim_matches('.').trim().to_string();
  if trimmed.is_empty() {
    "未命名文章".to_string()
  } else {
    trimmed
  }
}

fn path_conflicts(posts_root: &Path, stem: &str) -> bool {
  let post_dir = posts_root.join(stem);
  let markdown_path = post_dir.join(format!("{}.md", stem));
  post_dir.exists() || markdown_path.exists()
}

fn unique_slug(posts_root: &Path, title: &str, existing_slug: &str) -> String {
  if !existing_slug.trim().is_empty() {
    return existing_slug.trim().to_string();
  }

  let seed = sanitize_post_stem(title);
  let mut slug = seed.clone();
  let mut index = 1;

  while path_conflicts(posts_root, &slug) {
    slug = format!("{}_{}", seed, index);
    index += 1;
  }

  slug
}

fn render_markdown_content(request: &SavePostRequest, slug: &str) -> String {
  let title = request.title.trim();
  let description = request.description.replace("\r\n", " ").replace('\n', " ").trim().to_string();
  let body = request.body.replace("\r\n", "\n");
  let date = if request.date.trim().is_empty() {
    "1970-01-01".to_string()
  } else {
    request.date.trim().to_string()
  };

  let mut lines = vec![
    "---".to_string(),
    format!("title: {}", title),
    format!("description: {}", description),
    format!("date: {}", date),
  ];

  if !request.category.trim().is_empty() {
    lines.push(format!("category: {}", request.category.trim()));
  }

  if !request.parent.trim().is_empty() {
    lines.push(format!("parent: {}", request.parent.trim()));
  }

  lines.push(format!("order: {}", request.order));
  lines.push(format!("slug: {}", slug));
  lines.push("---".to_string());
  lines.push(String::new());
  lines.push(body);

  lines.join("\n")
}

#[tauri::command]
fn load_repository_snapshot(project_path: String) -> Result<RepositorySnapshot, String> {
  let project_root = PathBuf::from(project_path.trim());
  if !project_root.exists() {
    return Err(format!("路径不存在: {}", project_root.display()));
  }

  Ok(RepositorySnapshot {
    categories: read_categories(&project_root)?,
    posts: read_posts(&project_root)?,
  })
}

#[tauri::command]
fn load_post_document(file_path: String) -> Result<PostDocument, String> {
  let markdown_path = PathBuf::from(file_path.trim());
  if !markdown_path.exists() {
    return Err(format!("文章文件不存在: {}", markdown_path.display()));
  }

  let raw = fs::read_to_string(&markdown_path)
    .map_err(|error| format!("读取文章内容失败: {} ({})", markdown_path.display(), error))?;
  let (front_matter, body) = split_front_matter(&raw);

  let slug = front_matter
    .get("postId")
    .cloned()
    .or_else(|| front_matter.get("slug").cloned())
    .unwrap_or_else(|| {
      markdown_path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_default()
    });

  Ok(PostDocument {
    title: front_matter.get("title").cloned().unwrap_or_else(|| slug.clone()),
    description: front_matter.get("description").cloned().unwrap_or_default(),
    body: body.trim_start_matches('\n').to_string(),
    date: front_matter.get("date").cloned().unwrap_or_default(),
    slug,
    category: front_matter.get("category").cloned().unwrap_or_default(),
    parent: front_matter.get("parent").cloned().unwrap_or_default(),
    order: parse_order(front_matter.get("order"), 999),
    file_path: markdown_path.to_string_lossy().to_string(),
  })
}

#[tauri::command]
fn save_post(request: SavePostRequest) -> Result<PostRecord, String> {
  let project_root = PathBuf::from(request.project_path.trim());
  if !project_root.exists() {
    return Err(format!("路径不存在: {}", project_root.display()));
  }

  let posts_root = project_root.join("posts");
  fs::create_dir_all(&posts_root)
    .map_err(|error| format!("创建 posts 目录失败: {} ({})", posts_root.display(), error))?;

  let slug = unique_slug(&posts_root, &request.title, &request.existing_slug);
  let markdown_path = if !request.existing_file_path.trim().is_empty() {
    PathBuf::from(request.existing_file_path.trim())
  } else {
    let post_dir = posts_root.join(&slug);
    fs::create_dir_all(&post_dir)
      .map_err(|error| format!("创建文章目录失败: {} ({})", post_dir.display(), error))?;
    post_dir.join(format!("{}.md", slug))
  };

  if let Some(parent_dir) = markdown_path.parent() {
    fs::create_dir_all(parent_dir)
      .map_err(|error| format!("创建目标目录失败: {} ({})", parent_dir.display(), error))?;
  }

  let content = render_markdown_content(&request, &slug);
  fs::write(&markdown_path, content)
    .map_err(|error| format!("保存文章失败: {} ({})", markdown_path.display(), error))?;

  Ok(PostRecord {
    title: request.title.trim().to_string(),
    description: request.description.replace("\r\n", " ").replace('\n', " ").trim().to_string(),
    date: if request.date.trim().is_empty() {
      "1970-01-01".to_string()
    } else {
      request.date.trim().to_string()
    },
    slug: slug.clone(),
    category: request.category.trim().to_string(),
    parent: request.parent.trim().to_string(),
    order: request.order,
    file_name: markdown_path
      .file_stem()
      .map(|stem| stem.to_string_lossy().to_string())
      .unwrap_or_else(|| slug.clone()),
    file_path: markdown_path.to_string_lossy().to_string(),
    updated_at_ms: get_updated_at_ms(&markdown_path),
  })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      load_repository_snapshot,
      load_post_document,
      save_post
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
