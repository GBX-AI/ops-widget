# Ops Widget

One static HTML page that shows, side by side:

- **GitHub Actions** — what's deploying right now, and what the last *successful* run was, per workflow, per repo.
- **Azure** — month-to-date spend, daily trend, top services, credit remaining, and Container App health with live CPU/memory.

Live: **https://gbx-ai.github.io/ops-widget/**

![no build step](https://img.shields.io/badge/build-none-informational) ![no backend](https://img.shields.io/badge/backend-none-informational) ![secrets in repo](https://img.shields.io/badge/secrets%20in%20repo-zero-success)

---

## Why this repo is public and still safe

**There are no credentials in this repository, and there is nothing to leak.**

- The Azure app registration is a **public client (SPA)** — it has *no client secret*, by design. The client ID is not a credential; it identifies the app, and Entra will only ever return a token to the registered redirect URI.
- The GitHub token is **pasted by whoever opens the page** and stored in *their* browser's `localStorage`. It never reaches this repo, GitHub Pages, or any server.
- Sign-in is **auth-code + PKCE**. Every viewer authenticates as themselves and sees exactly what their own Azure RBAC allows.

So the page can be shared freely. Sharing the link grants nobody any access.

---

## Using it

Open the link, hit **Connect GitHub** and **Connect Azure**. Both persist, so it's a one-time step per device.

### GitHub

Paste a personal access token:

| Token type | Scopes needed |
|---|---|
| Classic | `repo` (private repos) or `public_repo` |
| Fine-grained | **Actions: read-only** + **Metadata: read-only** |

A classic token with no expiry stays connected indefinitely. Then pick which repos to watch — the picker lists everything you can see, filterable.

### Azure

Sign in with Microsoft. To see everything, the account wants:

| Panel | Role required on the subscription |
|---|---|
| Cost, trend, top services | **Cost Management Reader** (or Reader) |
| Container Apps status | **Reader** |
| CPU / memory sparklines | **Monitoring Reader** |

Missing a role degrades only that panel — the rest keeps working.

**On credit balance:** Azure exposes **no public API** for sponsorship or credit balance — only actual spend. So the widget asks you once for your grant total and start date, then subtracts real spend since that date. It's an accurate derivation, not a guess, but it is computed here rather than read from Azure.

---

## Session lifetime — the honest version

- **GitHub:** lasts until the token expires or you sign out. A no-expiry classic PAT is effectively permanent.
- **Azure:** Entra caps SPA refresh tokens at **24 hours** and they can't be extended — that's a platform rule, not a bug here. The widget works around it with a hidden `prompt=none` iframe that silently re-mints a token while your Microsoft session cookie is alive, so in practice you rarely see a prompt. When that cookie is gone too, you get one click to reconnect.

**Sign out** (Settings → *Sign out of everything*) erases the token, the Azure session and all settings from the browser.

---

## Running it locally

```bash
python -m http.server 8080     # or: npx serve -l 8080
```

Then open <http://localhost:8080/>. `http://localhost:8080/` is already registered as a redirect URI, so Azure sign-in works locally too.

Opening the file directly via `file://` works for the GitHub panel but **not** for Azure — OAuth redirect URIs can't be `file://`.

---

## Hosting your own copy

1. Fork, enable Pages (Settings → Pages → *Deploy from branch* → `main` / root).
2. Create your own Azure app registration and swap `AZ_CLIENT_ID` in `index.html`:

```bash
appId=$(az ad app create --display-name "Ops Widget" \
  --sign-in-audience AzureADMultipleOrgs --query appId -o tsv)
objId=$(az ad app show --id "$appId" --query id -o tsv)
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/applications/$objId" \
  --headers "Content-Type=application/json" \
  --body '{
    "spa":{"redirectUris":["https://YOUR-ORG.github.io/ops-widget/","http://localhost:8080/"]},
    "requiredResourceAccess":[{
      "resourceAppId":"797f4846-ba00-4fd7-ba43-dac1f8f63013",
      "resourceAccess":[{"id":"41094075-9dad-400e-a0bd-54e13aa8b0d5","type":"Scope"}]
    }]}'
echo "$appId"
```

`797f4846-…` is the Azure Service Management API; `41094075-…` is its `user_impersonation` scope.

---

## Notes

- Auto-refreshes every 60s, and **pauses while the tab is hidden** to save battery and API quota.
- Light/dark follows the OS with a manual override; the chart re-renders on theme change.
- Status is never carried by colour alone — every state pill pairs an icon and a text label, so it survives colour-vision differences and greyscale.
- Built as a single file with no dependencies. View source; it's all there.
