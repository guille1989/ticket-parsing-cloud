# Agent releases (S3) — prerrequisito OTA

Hosting del artefacto del **print-capture-agent** (`app.mjs`) para OTA.
Fase 0: bucket + convención + script de publicación. Fase 1: el heartbeat
autenticado puede devolver `{ update: { desiredVersion, url, sha256 } }`
(URL firmada de corta vida) cuando hay `desiredVersion` distinta a la
reportada.

## Bucket

CDK: `AgentReleasesBucket` en `lib/ticket-parsing-cloud-stack.ts`.

- Bloqueo público total, SSL obligatorio, versionado S3.
- Output: `AgentReleasesBucketName` tras `cdk deploy`.
- Env del script: `AGENT_RELEASES_BUCKET` (= ese output).

## Prefijo (inmutable por versión)

```text
agent-releases/<semver>/
  app.mjs              # bundle esbuild
  app.mjs.sha256       # hex SHA-256, una línea
  manifest.json        # metadatos (ver abajo)
```

No sobrescribir una versión ya publicada: publicar `0.5.1` nueva. Si hace
falta retirar, usar un kill-switch de policy en Fase 2, no borrar a ciegas.

### `manifest.json`

```json
{
  "version": "0.5.1",
  "sha256": "<hex>",
  "objectKey": "agent-releases/0.5.1/app.mjs",
  "minServiceVersion": null,
  "releasedAt": "2026-11-05T16:00:00.000Z"
}
```

## Integridad (decisión Fase 0)

| Capa | Estado |
|------|--------|
| **HTTPS + SHA-256** del `app.mjs`, hash en `app.mjs.sha256` y en `manifest.json` | **Mínimo obligatorio** para OTA JS (Fase 1 verifica antes del swap) |
| Firma asimétrica del manifiesto (clave de release en CI/Secrets Manager) | Deseable; no bloquea lab; documentar rotación cuando se añada |
| **Authenticode** del setup NSIS | Obligatorio para quiet install (Fase 3); **no** bloquea OTA de `app.mjs` |

Claves de firma: fuera del repo. Este documento no incluye secretos.

## Publicar

Desde un checkout con credenciales AWS de ops:

```bash
export AGENT_RELEASES_BUCKET=...   # output CDK
npm run publish-agent-release -- --file /path/to/app.mjs --version 0.5.1
# dry-run:
npm run publish-agent-release -- --file /path/to/app.mjs --version 0.5.1 --dry-run
```

El `app.mjs` sale de `agent-status-viewer` → `prepare-pilot.ps1`
(`src-tauri/resources/agent/app.mjs`).

## ACL / quién lee

- Escritura: rol/usuario del pipeline de release (ops).
- Lectura agents: **no** pública. Fase 1: Lambda de heartbeat tiene
  `s3:GetObject` y firma una URL (~15 min) embebida en la respuesta.

## Policy `desiredVersion` (Fase 1 — simple)

| Ámbito | Dónde | Cómo setear |
|--------|-------|-------------|
| Global | DynamoDB Agents `pk=OTA#GLOBAL` `sk=POLICY` | `npm run set-desired-agent-version -- --version X.Y.Z --apply` |
| Kill-switch | Misma fila, sin `desiredVersion` | `npm run set-desired-agent-version -- --clear --apply` |
| Override agent | `AgentRecord.desiredVersion` | `… --tenant … --agent … --version … --apply` |

Canary multi-tenant / porcentajes = Fase 2.

## Métricas

El heartbeat persiste `version` y, si el agent lo manda, `updateStatus` /
`updateStatusAt` / `updateError`. Admin CLI/consola muestran resumen por
versión. Contadores de rollout por cohorte = Fase 2.
