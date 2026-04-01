use serde::{Deserialize, Serialize};

use crate::indexer::Embedder;

const DEFAULT_MODEL_ID: &str = "qwen3-embedding-0.6b";
const DEFAULT_OLLAMA_MODEL: &str = "qwen3-embedding:0.6b";
const DEFAULT_OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";
const DEFAULT_EMBED_DIMS: usize = 1024;
const DEFAULT_QUERY_PREFIX: &str =
    "Instruct: Given a user search query, retrieve the most relevant personal notes\nQuery: ";

#[derive(Debug, Clone, PartialEq, Eq)]
struct EmbedderConfig {
    model_id: String,
    ollama_model: String,
    ollama_base_url: String,
    query_prefix: String,
    dims: usize,
}

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaTagModel>,
}

#[derive(Debug, Deserialize)]
struct OllamaTagModel {
    name: String,
}

#[derive(Debug, Serialize)]
struct OllamaEmbedRequest<'a> {
    model: &'a str,
    input: &'a str,
}

#[derive(Debug, Deserialize)]
struct OllamaEmbedResponse {
    #[serde(default)]
    embeddings: Vec<Vec<f32>>,
    #[serde(default)]
    embedding: Vec<f32>,
}

pub fn load_embedder_from_env() -> Result<Option<Box<dyn Embedder>>, String> {
    if std::env::var("MODEL_PATH").is_ok() || std::env::var("SEARCH_MODEL_PATH").is_ok() {
        return Err(
            "MODEL_PATH/SEARCH_MODEL_PATH is no longer supported by the Rust server build in this environment; configure SEARCH_OLLAMA_MODEL instead".to_string(),
        );
    }

    let Some(config) = EmbedderConfig::from_env()? else {
        return Ok(None);
    };

    // reqwest's blocking client spins up its own Tokio runtime internally.
    // The server owns the embedder for process lifetime, so leaking one client
    // instance avoids dropping that nested runtime from our async main context.
    let client = Box::leak(Box::new(
        reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| format!("Failed to build Ollama client: {e}"))?,
    ));

    probe_ollama(client, &config)?;

    tracing::info!(
        model_id = %config.model_id,
        ollama_model = %config.ollama_model,
        ollama_base_url = %config.ollama_base_url,
        dims = config.dims,
        "Configured Ollama embedding backend"
    );

    Ok(Some(Box::new(OllamaEmbedder { client, config })))
}

impl EmbedderConfig {
    fn from_env() -> Result<Option<Self>, String> {
        let ollama_base_url = std::env::var("SEARCH_OLLAMA_BASE_URL")
            .or_else(|_| std::env::var("OLLAMA_BASE_URL"))
            .or_else(|_| std::env::var("OLLAMA_HOST"))
            .ok()
            .filter(|s| !s.trim().is_empty());

        let ollama_model = match std::env::var("SEARCH_OLLAMA_MODEL")
            .or_else(|_| std::env::var("OLLAMA_EMBED_MODEL"))
        {
            Ok(value) if !value.trim().is_empty() => value,
            Ok(_) => return Ok(None),
            Err(_) => {
                if ollama_base_url.is_some() {
                    DEFAULT_OLLAMA_MODEL.to_string()
                } else {
                    return Ok(None);
                }
            }
        };

        let model_id = std::env::var("SEARCH_MODEL_ID")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL_ID.to_string());

        let query_prefix = std::env::var("SEARCH_QUERY_PREFIX")
            .ok()
            .unwrap_or_else(|| DEFAULT_QUERY_PREFIX.to_string());

        let dims = parse_usize_env("SEARCH_EMBED_DIMS").unwrap_or(DEFAULT_EMBED_DIMS);

        Ok(Some(Self {
            model_id,
            ollama_model,
            ollama_base_url: normalize_base_url(
                ollama_base_url
                    .as_deref()
                    .unwrap_or(DEFAULT_OLLAMA_BASE_URL),
            ),
            query_prefix,
            dims,
        }))
    }
}

fn parse_usize_env(key: &str) -> Option<usize> {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
}

fn normalize_base_url(input: &str) -> String {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    }
}

fn probe_ollama(client: &reqwest::blocking::Client, config: &EmbedderConfig) -> Result<(), String> {
    let version_url = format!("{}/api/version", config.ollama_base_url);
    client
        .get(&version_url)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|e| format!("Failed to reach Ollama at {}: {e}", config.ollama_base_url))?;

    let tags_url = format!("{}/api/tags", config.ollama_base_url);
    let tags = client
        .get(&tags_url)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|e| {
            format!(
                "Failed to query Ollama models at {}: {e}",
                config.ollama_base_url
            )
        })?
        .json::<OllamaTagsResponse>()
        .map_err(|e| format!("Failed to parse Ollama model list: {e}"))?;

    let has_model = tags.models.iter().any(|model| {
        model.name == config.ollama_model
            || model.name.starts_with(&format!("{}:", config.ollama_model))
    });
    if !has_model {
        return Err(format!(
            "Ollama model {} is not available at {}",
            config.ollama_model, config.ollama_base_url
        ));
    }

    Ok(())
}

struct OllamaEmbedder {
    client: &'static reqwest::blocking::Client,
    config: EmbedderConfig,
}

impl Embedder for OllamaEmbedder {
    fn model_id(&self) -> &str {
        &self.config.model_id
    }

    fn dims(&self) -> usize {
        self.config.dims
    }

    fn query_prefix(&self) -> &str {
        &self.config.query_prefix
    }

    fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        let url = format!("{}/api/embed", self.config.ollama_base_url);
        let response = self
            .client
            .post(&url)
            .json(&OllamaEmbedRequest {
                model: &self.config.ollama_model,
                input: text,
            })
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|e| format!("Ollama embed request failed: {e}"))?
            .json::<OllamaEmbedResponse>()
            .map_err(|e| format!("Failed to parse Ollama embed response: {e}"))?;

        let vector = if let Some(first) = response.embeddings.into_iter().next() {
            first
        } else if !response.embedding.is_empty() {
            response.embedding
        } else {
            return Err("Ollama returned no embedding vector".to_string());
        };

        if vector.len() != self.config.dims {
            return Err(format!(
                "Embedding dimension mismatch: expected {}, got {}",
                self.config.dims,
                vector.len()
            ));
        }

        Ok(vector)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Env vars are process-global — serialize tests that mutate them.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn clear_embedding_env() {
        for key in [
            "MODEL_PATH",
            "SEARCH_MODEL_PATH",
            "SEARCH_OLLAMA_MODEL",
            "OLLAMA_EMBED_MODEL",
            "SEARCH_OLLAMA_BASE_URL",
            "OLLAMA_BASE_URL",
            "OLLAMA_HOST",
            "SEARCH_MODEL_ID",
            "SEARCH_QUERY_PREFIX",
            "SEARCH_EMBED_DIMS",
        ] {
            std::env::remove_var(key);
        }
    }

    #[test]
    fn no_embedder_env_disables_embedder() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_embedding_env();
        let config = EmbedderConfig::from_env().unwrap();
        assert!(config.is_none());
    }

    #[test]
    fn normalizes_base_url_and_defaults() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_embedding_env();
        std::env::set_var("SEARCH_OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL);
        std::env::set_var("OLLAMA_HOST", "localhost:11434/");

        let config = EmbedderConfig::from_env().unwrap().unwrap();
        assert_eq!(config.model_id, DEFAULT_MODEL_ID);
        assert_eq!(config.ollama_model, DEFAULT_OLLAMA_MODEL);
        assert_eq!(config.ollama_base_url, "http://localhost:11434");
        assert_eq!(config.dims, DEFAULT_EMBED_DIMS);
        assert_eq!(config.query_prefix, DEFAULT_QUERY_PREFIX);

        clear_embedding_env();
    }

    #[test]
    fn parses_optional_overrides() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_embedding_env();
        std::env::set_var("SEARCH_OLLAMA_MODEL", "snowflake-arctic-embed2");
        std::env::set_var("SEARCH_OLLAMA_BASE_URL", "https://ollama.internal");
        std::env::set_var("SEARCH_MODEL_ID", "custom-model");
        std::env::set_var("SEARCH_QUERY_PREFIX", "query: ");
        std::env::set_var("SEARCH_EMBED_DIMS", "768");

        let config = EmbedderConfig::from_env().unwrap().unwrap();
        assert_eq!(config.model_id, "custom-model");
        assert_eq!(config.ollama_model, "snowflake-arctic-embed2");
        assert_eq!(config.ollama_base_url, "https://ollama.internal");
        assert_eq!(config.query_prefix, "query: ");
        assert_eq!(config.dims, 768);

        clear_embedding_env();
    }

    #[test]
    fn rejects_legacy_model_path_config() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_embedding_env();
        std::env::set_var("MODEL_PATH", "/tmp/model.gguf");

        let err = match load_embedder_from_env() {
            Ok(_) => panic!("expected legacy model path config to be rejected"),
            Err(err) => err,
        };
        assert!(err.contains("SEARCH_OLLAMA_MODEL"));

        clear_embedding_env();
    }
}
