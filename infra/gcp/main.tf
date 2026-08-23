# Cloud Run で Cacoo Remote MCP Server を動かす。
#
# 認証は Google アカウント (OAuth 2.0 クライアント) を上流 IdP として使う。
# Google 側の OAuth クライアント作成はコンソール操作が必要なため Terraform では
# 扱わず、作成済みのクライアント ID / secret を変数で受け取る。
#
#   terraform init
#   terraform apply -var-file=terraform.tfvars

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  name = var.service_name
}

# --- 有効化する API ---

resource "google_project_service" "required" {
  for_each = toset([
    "run.googleapis.com",
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# --- Firestore (OAuth の状態保存) ---

resource "google_firestore_database" "auth" {
  name        = var.firestore_database
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.required]
}

# 認可コードとトークンを自動失効させる。
# 削除は最大 24 時間遅れるため、アプリ側でも読み出し時に期限を検証している。
resource "google_firestore_field" "ttl" {
  database   = google_firestore_database.auth.name
  collection = var.firestore_collection
  field      = "expireAt"

  ttl_config {}
}

# --- シークレット ---

resource "google_secret_manager_secret" "cacoo_accounts" {
  secret_id = "${local.name}-cacoo-accounts-config"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "cacoo_accounts" {
  secret      = google_secret_manager_secret.cacoo_accounts.id
  secret_data = var.cacoo_accounts_config
}

resource "google_secret_manager_secret" "upstream_client_secret" {
  secret_id = "${local.name}-upstream-client-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "upstream_client_secret" {
  secret      = google_secret_manager_secret.upstream_client_secret.id
  secret_data = var.upstream_client_secret
}

# 同意画面の CSRF / 承認済みクライアント Cookie の署名鍵。
# 指定が無ければ生成する。値を変えると既存の承認状態が無効になる。
resource "random_password" "cookie" {
  length  = 64
  special = false
}

resource "google_secret_manager_secret" "cookie" {
  secret_id = "${local.name}-cookie-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "cookie" {
  secret      = google_secret_manager_secret.cookie.id
  secret_data = coalesce(var.cookie_secret, random_password.cookie.result)
}

# --- サービスアカウント ---

resource "google_service_account" "run" {
  account_id   = "${local.name}-run"
  display_name = "Cacoo Remote MCP Server (Cloud Run)"
}

resource "google_project_iam_member" "firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.run.email}"
}

resource "google_secret_manager_secret_iam_member" "access" {
  for_each = {
    accounts = google_secret_manager_secret.cacoo_accounts.id
    client = google_secret_manager_secret.upstream_client_secret.id
    cookie = google_secret_manager_secret.cookie.id
  }
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

# --- Cloud Run ---

resource "google_cloud_run_v2_service" "mcp" {
  name     = local.name
  location = var.region
  # MCP クライアントは Google の認証を持たないので、Cloud Run 自体は公開する。
  # アクセス制御はアプリ内の OAuth と ALLOWED_EMAILS で行う。
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.run.email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image

      ports {
        container_port = 8080
      }

      env {
        name  = "ISSUER_URL"
        value = var.public_base_url
      }
      env {
        name  = "ALLOWED_EMAILS"
        value = var.allowed_emails
      }
      env {
        name  = "UPSTREAM_IDP"
        value = var.upstream_idp
      }
      env {
        name  = "UPSTREAM_CLIENT_ID"
        value = var.upstream_client_id
      }
      # Entra ID を選んだ場合のみ使う
      env {
        name  = "UPSTREAM_TENANT_ID"
        value = var.upstream_tenant_id
      }
      env {
        name  = "FIRESTORE_COLLECTION"
        value = var.firestore_collection
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      # シークレットは名前だけ渡し、実行時に Secret Manager から解決する
      env {
        name  = "CACOO_ACCOUNTS_SECRET"
        value = google_secret_manager_secret.cacoo_accounts.secret_id
      }
      env {
        name  = "UPSTREAM_CLIENT_SECRET"
        value = google_secret_manager_secret.upstream_client_secret.secret_id
      }
      env {
        name  = "COOKIE_SECRET"
        value = google_secret_manager_secret.cookie.secret_id
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 6
      }
    }
  }

  depends_on = [google_project_service.required]
}

# MCP クライアントは未認証で到達する必要がある (認可はアプリ内で行う)
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.mcp.name
  location = google_cloud_run_v2_service.mcp.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- カスタムドメイン (任意) ---

resource "google_cloud_run_domain_mapping" "custom" {
  count    = var.custom_domain == "" ? 0 : 1
  name     = var.custom_domain
  location = var.region

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.mcp.name
  }
}
