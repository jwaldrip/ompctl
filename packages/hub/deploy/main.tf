# The hub, on Cloud Run. NOT APPLIED. Deploys run in CI on this project, never
# from a workstation, so this is the description of the target and nothing here
# has been executed.
#
# Two choices are load-bearing and worth reading before changing.
#
# `min_instance_count = 1`. The hub holds websockets, and an instance that
# scales to zero drops every daemon on it. The daemons reconnect, so this is a
# cost decision rather than a correctness one, but a hub that is always cold is
# a hub that is always reconnecting.
#
# Memorystore, not memory. Two legs of one session routinely land on two
# instances, and Cloud Run session affinity is best-effort, which is not a
# correctness mechanism. The routing table therefore lives outside the process.
# Without this the service only works pinned to a single instance.

# Backend and provider pins.
#
# The bucket is intentionally NOT hardcoded here: it is supplied at
# `terraform init -backend-config="bucket=..."` time by CI, which keeps the
# state location out of the tree and lets the same config target a different
# project without an edit. `prefix` alone is safe to commit; it carries no
# account information.
terraform {
  required_version = ">= 1.9"

  backend "gcs" {
    prefix = "hub"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

variable "project_id" { type = string }
variable "region" { type = string }
variable "image" { type = string }

variable "network_id" {
  type        = string
  description = "VPC the connector and Memorystore share."
}

variable "connector_id" {
  type        = string
  description = "Serverless VPC connector, so Cloud Run can reach Memorystore."
}

resource "google_redis_instance" "hub" {
  project = var.project_id
  region  = var.region

  name           = "ompd-hub"
  tier           = "BASIC"
  memory_size_gb = 1
  # Presence leases and a pub/sub fan-out. Nothing here is durable by design:
  # a total loss of this instance drops every session and every daemon
  # reconnects, which is a state the protocol already treats as normal.
  redis_version      = "REDIS_7_0"
  authorized_network = var.network_id
}

resource "google_secret_manager_secret" "operator_token" {
  project   = var.project_id
  secret_id = "ompd-hub-operator-token"
  replication {
    auto {}
  }
}

resource "google_service_account" "hub" {
  project    = var.project_id
  account_id = "ompd-hub"
}

resource "google_secret_manager_secret_iam_member" "hub_reads_operator_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.operator_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.hub.email}"
}

resource "google_cloud_run_v2_service" "hub" {
  project  = var.project_id
  location = var.region
  name     = "ompd-hub"

  # The hub brokers access to machines that execute code, and it authenticates
  # its own callers: daemons by signature, clients by a credential only the
  # daemon can read. IAM in front would break both legs, which arrive as
  # websockets from a phone and a laptop with no Google identity.
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.hub.email

    # One instance, deliberately, because this relay is stateful.
    #
    # A daemon's tunnel is registered with the single instance that accepted
    # its socket, and `sessionAffinity` is off. Fan out to ten and a phone can
    # be routed to an instance holding no tunnel for the daemon it is asking
    # about, which answers `daemon_offline` for a daemon that is plainly
    # connected. It is also a second, independent source of the
    # `4409 replaced by a newer connection` churn in a daemon's log: every
    # instance replacement re-registers the tunnel, and the observed log
    # carries four distinct hub instance ids.
    #
    # This is a single-operator relay, so one instance is not a bottleneck, it
    # is what makes routing deterministic. Raising this ceiling again requires
    # either session affinity that pins BOTH legs of a pair, or a shared
    # backplane so any instance can reach any daemon. Neither exists yet.
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    vpc_access {
      connector = var.connector_id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    # Cloud Run caps a request at 60 minutes and a websocket is a request, so
    # every connection is closed on a timer no matter what. Both ends treat
    # that as routine: the daemon reconnects with backoff and the client
    # resumes with `attach { sinceSeq }`.
    timeout = "3600s"

    containers {
      image = var.image

      env {
        name  = "OMPD_HUB_REDIS_URL"
        value = "redis://${google_redis_instance.hub.host}:${google_redis_instance.hub.port}"
      }

      env {
        name = "OMPD_HUB_OPERATOR_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.operator_token.secret_id
            version = "latest"
          }
        }
      }

      resources {
        # CPU stays allocated: a relay with no CPU between requests cannot
        # service a websocket, which is one long request with quiet stretches.
        cpu_idle = false
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      startup_probe {
        http_get {
          path = "/v1/health"
        }
      }
    }
  }
}

# Same shape as `google_cloud_run_v2_service_iam_member.web_public` below:
# daemons and phone clients arrive with no Google identity (see the comment
# on `ingress` above), so IAM in front of the service would refuse every one
# of them before the app's own daemon/token auth ever runs. Cloud Run
# services do NOT default to public even with ingress=ALL; this binding is
# required or the first apply ships a hub that 403s all traffic.
resource "google_cloud_run_v2_service_iam_member" "hub_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.hub.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "hub_url" {
  value = google_cloud_run_v2_service.hub.uri
}


# --- ompctl.ai edge: hub (relay) + app (web) + apex (marketing) ---------------
# Cloud DNS is the source of truth. Squarespace holds only the NS delegation
# to this zone. Terraform writes the zone, the Cloud Run domain mappings, and
# every record those mappings require. After apply, set the printed
# `nameservers` at Squarespace and nothing else.

variable "root_domain" {
  type        = string
  description = "Apex domain. Cloud DNS zone name and the marketing site mapping."
  default     = "ompctl.ai"
}

variable "app_domain" {
  type        = string
  description = "Public web + Universal Links host."
  default     = "app.ompctl.ai"
}

variable "hub_domain" {
  type        = string
  description = "Public hub/relay host."
  default     = "hub.ompctl.ai"
}

variable "domain_verification_txt" {
  type        = string
  description = "Existing Search Console verification TXT, including the google-site-verification= prefix. Required so Cloud Run domain mappings keep verifying after NS moves."
  default     = "google-site-verification=RQsotg_YAHqClM7v4W7jot1JeIQb517P0PlbNrsG188"
}

variable "web_image" {
  type        = string
  description = "Container image for the ompctl web console (app.ompctl.ai)."
}

variable "apple_team_id" {
  type        = string
  description = "Apple Team ID embedded in apple-app-site-association (10-char)."

  validation {
    condition     = can(regex("^[A-Z0-9]{10}$", var.apple_team_id))
    error_message = "apple_team_id must be a 10-character Apple Team ID; association files cannot ship placeholders."
  }
}

variable "play_cert_sha256" {
  type        = string
  description = "Google Play app signing certificate SHA-256 for assetlinks.json (not the upload key)."

  validation {
    condition     = can(regex("^(?i)([0-9A-F]{2}:){31}[0-9A-F]{2}$", var.play_cert_sha256)) || can(regex("^(?i)[0-9A-F]{64}$", var.play_cert_sha256))
    error_message = "play_cert_sha256 must be the Play app signing cert SHA-256 fingerprint (with or without colons)."
  }
}

resource "google_service_account" "web" {
  project    = var.project_id
  account_id = "ompctl-web"
}

resource "google_cloud_run_v2_service" "web" {
  project  = var.project_id
  location = var.region
  name     = "ompctl-web"

  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.web.email

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    containers {
      image = var.web_image

      env {
        name  = "OMPCTL_APPLE_TEAM_ID"
        value = var.apple_team_id
      }

      env {
        name  = "OMPCTL_PLAY_CERT_SHA256"
        value = var.play_cert_sha256
      }

      env {
        name  = "OMPCTL_IOS_BUNDLE_ID"
        value = "ai.ompctl.app"
      }

      env {
        name  = "OMPCTL_MACOS_BUNDLE_ID"
        value = "ai.ompctl.app"
      }

      env {
        name  = "OMPCTL_ANDROID_PACKAGE"
        value = "ai.ompctl.app"
      }

      resources {
        cpu_idle = true
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

variable "site_image" {
  type        = string
  description = "Container image for the ompctl marketing site (the ompctl.ai apex)."
}

resource "google_service_account" "site" {
  project    = var.project_id
  account_id = "ompctl-site"
}

# The apex is a separate service from the console on purpose. `ompctl-web`
# serves the SPA and owns the Universal Link association documents; mapping the
# apex onto it would put the marketing page and those documents behind one
# deploy, and a bad site build would then take Universal Links down with it.
resource "google_cloud_run_v2_service" "site" {
  project  = var.project_id
  location = var.region
  name     = "ompctl-site"

  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.site.email

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    containers {
      image = var.site_image

      resources {
        cpu_idle = true
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "site_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.site.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Cloud Run refuses to create a domain mapping unless the CALLER has verified
# ownership of the domain. That check is per-identity, not per-project: the
# human owner of ompctl.ai is verified in Search Console, the CI deployer
# service account is not, and ownership cannot be granted to it over any API
# scope this stack holds (siteVerification needs a scope the deploy identity
# is never given).
#
# So CI does NOT own the mappings. They are created once by the verified owner
# and left alone; a `terraform apply` that tried to create them put all four
# into a permanent `Ready:False, Caller is not authorized` state and had to be
# repaired by hand. This flag exists so the mappings CAN move into Terraform
# the moment the deployer is added as an owner of the domain, without a
# rewrite: set it true and apply.
#
# The zone and its records below are unaffected: `roles/dns.admin` is a normal
# project role, so Cloud DNS is fully Terraform-managed either way.
variable "manage_domain_mappings" {
  type        = bool
  description = "Let Terraform create the Cloud Run domain mappings. Requires the deploy service account to be a verified owner of root_domain in Search Console."
  default     = false
}

resource "google_cloud_run_domain_mapping" "app" {
  count    = var.manage_domain_mappings ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = var.app_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.web.name
  }
}

resource "google_cloud_run_domain_mapping" "hub" {
  count    = var.manage_domain_mappings ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = var.hub_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.hub.name
  }
}

resource "google_cloud_run_domain_mapping" "root" {
  count    = var.manage_domain_mappings ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = var.root_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.site.name
  }
}

resource "google_cloud_run_domain_mapping" "www" {
  count    = var.manage_domain_mappings ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = "www.${var.root_domain}"

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.site.name
  }
}

# dns.googleapis.com is NOT declared here. Enabling a service is an owner
# action (`serviceusage.services.enable`), the deploy identity does not hold it,
# and a `google_project_service` resource would therefore fail every apply on a
# service that is already on. bootstrap.sh enables it once, as the owner.
resource "google_project_iam_member" "deployer_dns" {
  project = var.project_id
  role    = "roles/dns.admin"
  member  = "serviceAccount:ompctl-deployer@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_dns_managed_zone" "ompctl" {
  project     = var.project_id
  name        = replace(var.root_domain, ".", "-")
  dns_name    = "${var.root_domain}."
  description = "ompctl.ai. Squarespace holds only the NS delegation."

  depends_on = [google_project_iam_member.deployer_dns]
}

# Cloud Run's mapping targets, written out rather than read from
# `google_cloud_run_domain_mapping.*.status`.
#
# The status block is the authority, but it is only populated AFTER the mapping
# is created, so a `for_each` over it is unknown at plan time and Terraform
# refuses the plan outright ("Invalid for_each argument"). These values are
# Google's published anycast frontends for Cloud Run / App Engine custom
# domains, and were confirmed against the live mappings for this project:
# subdomains take the CNAME, an apex takes the four A and four AAAA records.
locals {
  cloud_run_cname = "ghs.googlehosted.com."
  cloud_run_a = [
    "216.239.32.21",
    "216.239.34.21",
    "216.239.36.21",
    "216.239.38.21",
  ]
  cloud_run_aaaa = [
    "2001:4860:4802:32::15",
    "2001:4860:4802:34::15",
    "2001:4860:4802:36::15",
    "2001:4860:4802:38::15",
  ]
}

resource "google_dns_record_set" "hub" {
  project      = var.project_id
  managed_zone = google_dns_managed_zone.ompctl.name
  name         = "${var.hub_domain}."
  type         = "CNAME"
  ttl          = 300
  rrdatas      = [local.cloud_run_cname]

  depends_on = [google_cloud_run_domain_mapping.hub]
}

resource "google_dns_record_set" "app" {
  project      = var.project_id
  managed_zone = google_dns_managed_zone.ompctl.name
  name         = "${var.app_domain}."
  type         = "CNAME"
  ttl          = 300
  rrdatas      = [local.cloud_run_cname]

  depends_on = [google_cloud_run_domain_mapping.app]
}

resource "google_dns_record_set" "www" {
  project      = var.project_id
  managed_zone = google_dns_managed_zone.ompctl.name
  name         = "www.${var.root_domain}."
  type         = "CNAME"
  ttl          = 300
  rrdatas      = [local.cloud_run_cname]

  depends_on = [google_cloud_run_domain_mapping.www]
}

# An apex cannot hold a CNAME, so it takes the address records instead.
resource "google_dns_record_set" "root_a" {
  project      = var.project_id
  managed_zone = google_dns_managed_zone.ompctl.name
  name         = google_dns_managed_zone.ompctl.dns_name
  type         = "A"
  ttl          = 300
  rrdatas      = local.cloud_run_a

  depends_on = [google_cloud_run_domain_mapping.root]
}

resource "google_dns_record_set" "root_aaaa" {
  project      = var.project_id
  managed_zone = google_dns_managed_zone.ompctl.name
  name         = google_dns_managed_zone.ompctl.dns_name
  type         = "AAAA"
  ttl          = 300
  rrdatas      = local.cloud_run_aaaa

  depends_on = [google_cloud_run_domain_mapping.root]
}

resource "google_dns_record_set" "apex_txt" {
  project      = var.project_id
  managed_zone = google_dns_managed_zone.ompctl.name
  name         = google_dns_managed_zone.ompctl.dns_name
  type         = "TXT"
  ttl          = 300
  rrdatas = [
    "\"${var.domain_verification_txt}\"",
    "\"v=spf1 -all\"",
  ]
}

resource "google_dns_record_set" "dmarc" {
  project      = var.project_id
  managed_zone = google_dns_managed_zone.ompctl.name
  name         = "_dmarc.${var.root_domain}."
  type         = "TXT"
  ttl          = 300
  rrdatas      = ["\"v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s\""]
}

resource "google_dns_record_set" "domainkey" {
  project      = var.project_id
  managed_zone = google_dns_managed_zone.ompctl.name
  name         = "_domainkey.${var.root_domain}."
  type         = "TXT"
  ttl          = 300
  rrdatas      = ["\"v=DKIM1; p=\""]
}

output "app_domain" { value = var.app_domain }
output "hub_domain" { value = var.hub_domain }
output "web_url" { value = google_cloud_run_v2_service.web.uri }
output "site_url" { value = google_cloud_run_v2_service.site.uri }

output "nameservers" {
  description = "Set these as the NS records at Squarespace. Nothing else lives there."
  value       = google_dns_managed_zone.ompctl.name_servers
}

output "root_domain" { value = var.root_domain }

output "product_identity" {
  value = {
    ios_bundle_id     = "ai.ompctl.app"
    android_package   = "ai.ompctl.app"
    macos_bundle_id   = "ai.ompctl.app"
    windows_package   = "ai.ompctl.app"
    marketing_origin  = "https://${var.root_domain}"
    web_origin        = "https://${var.app_domain}"
    hub_origin        = "https://${var.hub_domain}"
    collab_link_base  = "https://${var.app_domain}/collab"
    custom_url_scheme = "ompctl"
  }
}
