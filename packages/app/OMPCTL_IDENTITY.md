# ompctl identity

Product domain: **ompctl.ai**. Cloud DNS is the source of truth. Squarespace holds only the NS delegation.

| Surface | Value |
|---------|--------|
| iOS bundle id | `ai.ompctl.app` |
| Android applicationId | `ai.ompctl.app` |
| macOS bundle id | `ai.ompctl.app` |
| Windows package | `ai.ompctl.app` |
| Web / Universal Links | `https://app.ompctl.ai` (Cloud Run **ompctl-web**) |
| Hub / relay | `https://hub.ompctl.ai` (Cloud Run **ompd-hub**) |
| Custom URL scheme | `ompctl://` |
| Collab join URL | `https://app.ompctl.ai/collab/<roomId>` |

## Host split (load-bearing)

- **`app.ompctl.ai`** serves the web console **and** `/.well-known/apple-app-site-association` + `assetlinks.json`.
- **`hub.ompctl.ai`** is the relay: the websocket legs, plus `POST /v1/webhooks/<daemonId>/<routineId>`, which it tunnels to the pinned daemon. It does **not** serve the SPA or association files.

Mapping the app host onto the hub image would break Universal Links and leave the web app undeployed.

## DNS

Terraform owns the Cloud DNS zone and every record on it (hub, app, apex, www, verification, mail-policy TXT). After CI `terraform apply`:

    terraform -chdir=packages/hub/deploy output -json nameservers

Set those nameservers at Squarespace. Do not create A or CNAME records there.

## GitHub Actions vars (hub-deploy environment)

| Var | Purpose |
|-----|---------|
| `GCP_*` / `TF_STATE_BUCKET` | existing deploy |
| `OMPCTL_APPLE_TEAM_ID` | AASA `appIDs` |
| `OMPCTL_PLAY_CERT_SHA256` | assetlinks fingerprint |
| `OMPCTL_APP_DOMAIN` | default `app.ompctl.ai` |
| `OMPCTL_HUB_DOMAIN` | default `hub.ompctl.ai` |

## Store consoles

Register apps under the new bundle ids (not `sh.ompd.*`):

- App Store Connect: `ai.ompctl.app` (one record, iOS + macOS)
- Play Console: `ai.ompctl.app`

## Association fail-closed

`ompctl-web` refuses to start without `OMPCTL_APPLE_TEAM_ID` and
`OMPCTL_PLAY_CERT_SHA256`. Terraform validates both. There is no placeholder
path that can look healthy on a device check.
