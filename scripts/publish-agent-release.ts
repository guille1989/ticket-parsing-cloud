/**
 * Publica un bundle `app.mjs` al bucket de releases (Fase 0 OTA).
 *
 * Uso:
 *   AGENT_RELEASES_BUCKET=... npm run publish-agent-release -- --file ./app.mjs --version 0.5.1
 *   ... --dry-run
 *
 * Escribe bajo agent-releases/<version>/ : app.mjs, app.mjs.sha256, manifest.json.
 * No sobrescribe si ya existe app.mjs para esa versión (salvo --force).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const PREFIX = "agent-releases";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta env ${name}`);
  return value;
}

function assertSemverLike(version: string): void {
  if (!/^\d+\.\d+\.\d+([.-][A-Za-z0-9.-]+)?$/.test(version)) {
    throw new Error(`versión inválida "${version}" (esperado semver-like, ej. 0.5.1)`);
  }
}

async function objectExists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (err as { name?: string }).name === "NotFound" || (err as { name?: string }).name === "NoSuchKey") {
      return false;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const file = arg("file");
  const version = arg("version");
  const dryRun = hasFlag("dry-run");
  const force = hasFlag("force");
  const minServiceVersion = arg("min-service-version") ?? null;

  if (!file || !version) {
    console.error("uso: publish-agent-release --file <app.mjs> --version <semver> [--min-service-version X] [--dry-run] [--force]");
    process.exitCode = 1;
    return;
  }
  assertSemverLike(version);

  const bucket = requireEnv("AGENT_RELEASES_BUCKET");
  const absolute = resolve(file);
  const body = readFileSync(absolute);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const baseKey = `${PREFIX}/${version}`;
  const appKey = `${baseKey}/app.mjs`;
  const shaKey = `${baseKey}/app.mjs.sha256`;
  const manifestKey = `${baseKey}/manifest.json`;
  const releasedAt = new Date().toISOString();
  const manifest = {
    version,
    sha256,
    objectKey: appKey,
    minServiceVersion,
    releasedAt,
  };

  console.log(`Bucket:  ${bucket}`);
  console.log(`File:    ${absolute} (${body.length} bytes)`);
  console.log(`Version: ${version}`);
  console.log(`SHA256:  ${sha256}`);
  console.log(`Keys:    ${appKey}, ${shaKey}, ${manifestKey}`);

  if (dryRun) {
    console.log("Dry-run: no se subió nada.");
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const s3 = new S3Client({ region });

  if (!force && (await objectExists(s3, bucket, appKey))) {
    throw new Error(`${appKey} ya existe. Publicá otra versión o pasá --force (no recomendado).`);
  }

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: appKey,
    Body: body,
    ContentType: "text/javascript; charset=utf-8",
    Metadata: { sha256, "agent-version": version },
  }));
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: shaKey,
    Body: `${sha256}\n`,
    ContentType: "text/plain; charset=utf-8",
  }));
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: manifestKey,
    Body: JSON.stringify(manifest, null, 2) + "\n",
    ContentType: "application/json; charset=utf-8",
  }));

  console.log("Publicado.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
