//! 受控外链打开（D5.1-P1，`DESK-PARITY-003` / `DESK-ONLINE-014`）。
//!
//! renderer 没有任何原生打开能力：`window.open` 在受控 webview 里不是把内容交给系统
//! 浏览器的语义。普通外链与固定云账号入口共用校验机制，收敛成一次经过校验的
//! `open::that` 调用：
//!
//! - scheme 只允许 `http`/`https`；
//! - 拒绝 `file:`、`javascript:`、`data:` 与任意自定义协议；
//! - 拒绝带凭据（userinfo）的 URL——`https://user:pass@host/` 不是无害的笔误，它会
//!   把凭据写进浏览器历史；
//! - 校验的是解析后的 URL 结构，不是字符串前缀：`HTTPS://EXAMPLE.COM`、
//!   `https://example.com:443` 等规范等价形式同样通过。
//!
//! 「哪些链接该弹确认」是 renderer 的产品决策（固定产品链接不弹、内容链接默认弹）；
//! 这里的校验是安全语义，不因为调用方已经弹过确认而放松。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub enum CloudAccountPage {
    AccountSecurity,
    PasswordRecovery,
}

impl TryFrom<String> for CloudAccountPage {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "account-security" => Ok(Self::AccountSecurity),
            "password-recovery" => Ok(Self::PasswordRecovery),
            _ => Err("未知的账号页面"),
        }
    }
}

#[derive(Debug)]
pub struct OpenCloudAccountPageRequest {
    pub page: CloudAccountPage,
}

impl<'de> Deserialize<'de> for OpenCloudAccountPageRequest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectOnly;
        impl<'de> serde::de::Visitor<'de> for ObjectOnly {
            type Value = OpenCloudAccountPageRequest;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("仅包含 page 的账号页面请求对象")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> Result<Self::Value, A::Error> {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Fields {
                    page: CloudAccountPage,
                }
                let fields =
                    Fields::deserialize(serde::de::value::MapAccessDeserializer::new(map))?;
                Ok(OpenCloudAccountPageRequest { page: fields.page })
            }
        }
        deserializer.deserialize_map(ObjectOnly)
    }
}

/// origin 只能来自 CloudState；不继承查询、fragment 或恢复 token。
pub fn cloud_account_page_url(
    origin: &str,
    page: CloudAccountPage,
) -> Result<url::Url, ExternalLinkError> {
    let mut url = validate_external_url(origin)?;
    let (path, query) = match page {
        CloudAccountPage::AccountSecurity => ("/settings", Some("section=account")),
        CloudAccountPage::PasswordRecovery => ("/password-recovery", None),
    };
    url.set_path(path);
    url.set_query(query);
    url.set_fragment(None);
    validate_external_url(url.as_str())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalLinkErrorCode {
    InvalidUrl,
    OpenFailed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalLinkError {
    pub code: ExternalLinkErrorCode,
    pub message: String,
}

impl ExternalLinkError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: ExternalLinkErrorCode::InvalidUrl,
            message: message.into(),
        }
    }
}

/// 单条 URL 的最大长度，与 `desktop-ipc` 契约 `MAX_DESKTOP_EXTERNAL_URL_LENGTH` 一致。
const MAX_EXTERNAL_URL_LENGTH: usize = 2048;

/// 把 renderer 给的字符串解析成一个可以交给系统浏览器的 URL。
///
/// 全部拒绝都在这一个函数里完成——命令实现不再复述规则，保证「能打开的」与
/// 「通过校验的」是同一个集合。
pub fn validate_external_url(raw: &str) -> Result<url::Url, ExternalLinkError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ExternalLinkError::invalid("URL 为空"));
    }
    if trimmed.len() > MAX_EXTERNAL_URL_LENGTH {
        return Err(ExternalLinkError::invalid("URL 超出长度上限"));
    }
    // 控制字符与空白会让 url::Url 在部分实现下静默截断或折叠，先于解析拒绝，
    // 让「实际打开的 URL」与「renderer 展示的 URL」不可能是两个东西。
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(ExternalLinkError::invalid("URL 含非法字符"));
    }

    let url =
        url::Url::parse(trimmed).map_err(|_| ExternalLinkError::invalid("无法解析为合法 URL"))?;

    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(ExternalLinkError::invalid(format!("不允许的协议：{other}")));
        }
    }
    if url.host_str().is_none() {
        return Err(ExternalLinkError::invalid("URL 缺少主机名"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ExternalLinkError::invalid("URL 不得携带凭据"));
    }

    Ok(url)
}

/// 打开一个已经过校验的外部 URL；系统调用失败不静默。
pub fn open_validated_url(url: &url::Url) -> Result<(), ExternalLinkError> {
    open::that(url.as_str()).map_err(|error| ExternalLinkError {
        code: ExternalLinkErrorCode::OpenFailed,
        message: format!("系统浏览器打开失败：{error}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_account_pages_use_only_fixed_paths_on_the_current_origin() {
        for origin in [
            "https://mahoshojo.colanns.me",
            "http://127.0.0.1:8787",
            "http://localhost:3000",
            "https://dev.example.test",
        ] {
            for (page, suffix) in [
                (
                    CloudAccountPage::AccountSecurity,
                    "/settings?section=account",
                ),
                (CloudAccountPage::PasswordRecovery, "/password-recovery"),
            ] {
                let source =
                    format!("{origin}/old?token=must-not-propagate&returnTo=other#private");
                let target = cloud_account_page_url(&source, page).unwrap();
                assert_eq!(target.as_str(), format!("{origin}{suffix}"));
            }
        }
    }

    #[test]
    fn cloud_account_pages_use_managed_default_or_compiled_debug_origin() {
        let state = crate::cloud::CloudState::new().unwrap();
        let target =
            cloud_account_page_url(state.origin(), CloudAccountPage::PasswordRecovery).unwrap();
        let origin = url::Url::parse(&crate::cloud::cloud_origin()).unwrap();
        assert_eq!(target.origin(), origin.origin());
        assert_eq!(target.path(), "/password-recovery");
        assert_eq!(target.query(), None);
        assert_eq!(target.fragment(), None);
    }

    #[test]
    fn cloud_account_pages_reject_invalid_origins_before_opening() {
        for origin in [
            "https://user:password@example.test",
            "javascript:alert(1)",
            "file:///tmp/page",
            "not a url",
        ] {
            for page in [
                CloudAccountPage::AccountSecurity,
                CloudAccountPage::PasswordRecovery,
            ] {
                assert_eq!(
                    cloud_account_page_url(origin, page).unwrap_err().code,
                    ExternalLinkErrorCode::InvalidUrl
                );
            }
        }
    }

    #[test]
    fn cloud_account_page_requests_are_closed_and_have_no_account_parameters() {
        for page in ["account-security", "password-recovery"] {
            let request = serde_json::json!({ "page": page });
            let parsed: OpenCloudAccountPageRequest =
                serde_json::from_value(request.clone()).unwrap();
            assert_eq!(
                parsed.page,
                if page == "account-security" {
                    CloudAccountPage::AccountSecurity
                } else {
                    CloudAccountPage::PasswordRecovery
                }
            );
            for key in [
                "url", "query", "token", "userId", "email", "returnTo", "origin",
            ] {
                let mut extra = request.clone();
                extra[key] = serde_json::json!("untrusted");
                assert!(serde_json::from_value::<OpenCloudAccountPageRequest>(extra).is_err());
            }
        }
        for request in [
            serde_json::json!(["account-security"]),
            serde_json::json!(["password-recovery"]),
            serde_json::json!({}),
            serde_json::json!({"page": "login"}),
            serde_json::json!({"page": {"account-security": null}}),
            serde_json::json!({"page": {"password-recovery": null}}),
            serde_json::json!({"page": {"url": "https://example.test"}}),
            serde_json::json!({"page": null}),
        ] {
            assert!(serde_json::from_value::<OpenCloudAccountPageRequest>(request).is_err());
        }
        assert!(serde_json::from_str::<OpenCloudAccountPageRequest>(
            r#"{"page":"account-security","page":"password-recovery"}"#
        )
        .is_err());
    }

    #[test]
    fn accepts_plain_http_and_https() {
        for raw in [
            "https://mahoshojo.colanns.me/encyclopedia",
            "http://example.com/a?b=c#frag",
            "HTTPS://EXAMPLE.COM/PATH",
        ] {
            assert!(validate_external_url(raw).is_ok(), "{raw}");
        }
    }

    #[test]
    fn rejects_non_web_schemes() {
        for raw in [
            "file:///C:/Windows/System32/drivers/etc/hosts",
            "javascript:alert(1)",
            "data:text/html;base64,PGI+PC9iPg==",
            "maho-webpkg://localhost/x",
            "tauri://localhost/index.html",
            "vbscript:x",
            "shell:AppsFolder\\x",
        ] {
            let error = validate_external_url(raw).expect_err(raw);
            assert_eq!(error.code, ExternalLinkErrorCode::InvalidUrl, "{raw}");
        }
    }

    #[test]
    fn rejects_credentials_and_malformed_inputs() {
        for raw in [
            "https://user:pass@example.com/",
            "https://user@example.com/",
            "",
            "   ",
            "not a url",
            "https://example .com/",
            "https://example.com/\nSet-Cookie: x=1",
            "\\\\example.com\\share",
        ] {
            let error = validate_external_url(raw).expect_err(raw);
            assert_eq!(error.code, ExternalLinkErrorCode::InvalidUrl, "{raw:?}");
        }
    }

    #[test]
    fn rejects_oversized_urls() {
        let url = format!(
            "https://example.com/{}",
            "a".repeat(MAX_EXTERNAL_URL_LENGTH)
        );
        assert!(validate_external_url(&url).is_err());
    }
}
