variable "project_id" {
  description = "デプロイ先の Google Cloud プロジェクト ID"
  type        = string
}

variable "region" {
  description = "Cloud Run のリージョン"
  type        = string
  default     = "asia-northeast1"
}

variable "service_name" {
  description = "Cloud Run サービス名。各リソースの名前の接頭辞にもなる"
  type        = string
  default     = "cacoo-mcp"
}

variable "image" {
  description = "Artifact Registry のコンテナイメージ URI"
  type        = string
}

variable "public_base_url" {
  description = "このサーバの公開 URL (末尾スラッシュなし)。OAuth の issuer になる"
  type        = string
}

variable "custom_domain" {
  description = "カスタムドメイン。空ならドメインマッピングを作らず run.app の URL を使う"
  type        = string
  default     = ""
}

variable "allowed_emails" {
  description = "ツールの利用を許可するメールアドレスの JSON 配列。空なら制限なし"
  type        = string
  default     = "[]"
}

variable "upstream_idp" {
  description = "上流 IdP。google または entra"
  type        = string
  default     = "google"

  validation {
    condition     = contains(["google", "entra"], var.upstream_idp)
    error_message = "upstream_idp must be either \"google\" or \"entra\"."
  }
}

variable "upstream_client_id" {
  description = "上流 IdP の OAuth クライアント ID"
  type        = string
}

variable "upstream_client_secret" {
  description = "上流 IdP の OAuth クライアント secret"
  type        = string
  sensitive   = true
}

variable "upstream_tenant_id" {
  description = "Entra ID を選んだ場合のテナント ID。Google のときは空でよい"
  type        = string
  default     = ""
}

variable "cacoo_accounts_config" {
  description = "CACOO_ACCOUNTS_CONFIG の JSON 文字列"
  type        = string
  sensitive   = true
}

variable "cookie_secret" {
  description = "同意画面の Cookie 署名鍵。空なら生成する"
  type        = string
  sensitive   = true
  default     = null
}

variable "firestore_database" {
  description = "Firestore データベース名"
  type        = string
  default     = "(default)"
}

variable "firestore_location" {
  description = "Firestore のロケーション"
  type        = string
  default     = "asia-northeast1"
}

variable "firestore_collection" {
  description = "OAuth の状態を入れるコレクション名"
  type        = string
  default     = "cacoo-mcp-auth"
}

variable "min_instances" {
  description = "最小インスタンス数。0 なら未使用時は課金されないがコールドスタートが出る"
  type        = number
  default     = 0
}

variable "max_instances" {
  type    = number
  default = 3
}

variable "cpu" {
  type    = string
  default = "1"
}

variable "memory" {
  type    = string
  default = "512Mi"
}
