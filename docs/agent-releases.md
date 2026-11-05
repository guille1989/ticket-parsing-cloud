# Agent releases (S3) — prerrequisito OTA

Hosting del artefacto del **print-capture-agent** (`app.mjs`) para futuras
actualizaciones OTA. Fase 0: bucket + convención + script de publicación.
**Todavía no** hay auto-download en el agent ni señal `desiredVersion` en
heartbeat (eso es Fase 1).

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
- Lectura agents: **no** pública. Fase 1 entregará URL firmada de corta vida
  o el hash vía respuesta de heartbeat autenticada con API key.

## Métricas

El heartbeat ya persiste `version` en `Agents`. Admin CLI/consola muestran
cada agent y un **resumen por versión** del tenant. Dashboard Cognito lista
`version` por robot. Contadores `updateStatus` / `desiredVersion` = Fase 1+.
