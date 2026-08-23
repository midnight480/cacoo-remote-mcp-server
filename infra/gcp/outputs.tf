output "service_url" {
  description = "Cloud Run が払い出す URL"
  value       = google_cloud_run_v2_service.mcp.uri
}

output "mcp_endpoint" {
  description = "MCP クライアントに設定する URL"
  value       = "${var.public_base_url}/mcp"
}

output "oauth_redirect_uri" {
  description = "上流 IdP の OAuth クライアントに登録するリダイレクト URI"
  value       = "${var.public_base_url}/callback"
}

output "service_account" {
  description = "Cloud Run が使うサービスアカウント"
  value       = google_service_account.run.email
}

output "custom_domain_records" {
  description = "カスタムドメインを使う場合に設定する DNS レコード"
  value = var.custom_domain == "" ? [] : try(
    google_cloud_run_domain_mapping.custom[0].status[0].resource_records, []
  )
}
