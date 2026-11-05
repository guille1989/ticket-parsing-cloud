import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

import { AGENTS_TABLE, ddb } from "../shared/dynamo.js";

/** Policy global OTA (Fase 1: un desiredVersion para toda la flota). */
export const OTA_GLOBAL_KEY = { pk: "OTA#GLOBAL", sk: "POLICY" } as const;

const RELEASES_PREFIX = "agent-releases";
const PRESIGN_TTL_SECONDS = 15 * 60;

export interface OtaGlobalPolicy {
  desiredVersion?: string;
  updatedAt?: string;
}

export interface AgentUpdateSignal {
  desiredVersion: string;
  url: string;
  sha256: string;
}

interface AgentReleaseManifest {
  version: string;
  sha256: string;
  objectKey: string;
}

const s3 = new S3Client({});

export function releasesBucket(): string {
  return process.env.AGENT_RELEASES_BUCKET?.trim() ?? "";
}

/** Versión deseada global; vacío/ausente = sin OTA (kill-switch). */
export async function loadGlobalDesiredVersion(): Promise<string | undefined> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: AGENTS_TABLE,
    Key: OTA_GLOBAL_KEY,
  }));
  const version = (Item as OtaGlobalPolicy | undefined)?.desiredVersion;
  if (typeof version !== "string") return undefined;
  const trimmed = version.trim();
  return trimmed || undefined;
}

/**
 * Efectiva = override del agent si está seteado (string no vacío), si no la global.
 * Un agent con `desiredVersion` vacío explícito no se modela acá: omitir el
 * campo = heredar global. Kill-switch de flota = borrar/vaciar la global.
 */
export function resolveDesiredVersion(
  agentDesired: string | undefined,
  globalDesired: string | undefined,
): string | undefined {
  const fromAgent = typeof agentDesired === "string" ? agentDesired.trim() : "";
  if (fromAgent) return fromAgent;
  const fromGlobal = typeof globalDesired === "string" ? globalDesired.trim() : "";
  return fromGlobal || undefined;
}

export async function loadReleaseManifest(version: string): Promise<AgentReleaseManifest | undefined> {
  const bucket = releasesBucket();
  if (!bucket) return undefined;
  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: `${RELEASES_PREFIX}/${version}/manifest.json`,
    }));
    const text = await result.Body?.transformToString("utf-8");
    if (!text) return undefined;
    const parsed = JSON.parse(text) as Partial<AgentReleaseManifest>;
    if (
      typeof parsed.version !== "string" ||
      !parsed.version.trim() ||
      typeof parsed.sha256 !== "string" ||
      !/^[a-fA-F0-9]{64}$/.test(parsed.sha256.trim()) ||
      typeof parsed.objectKey !== "string" ||
      !parsed.objectKey.trim()
    ) {
      return undefined;
    }
    return {
      version: parsed.version.trim(),
      sha256: parsed.sha256.trim().toLowerCase(),
      objectKey: parsed.objectKey.trim(),
    };
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (err as { name?: string }).name === "NoSuchKey") return undefined;
    throw err;
  }
}

export async function buildUpdateSignal(desiredVersion: string): Promise<AgentUpdateSignal | undefined> {
  const bucket = releasesBucket();
  if (!bucket) return undefined;
  const manifest = await loadReleaseManifest(desiredVersion);
  if (!manifest || manifest.version !== desiredVersion) return undefined;
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: manifest.objectKey }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );
  return {
    desiredVersion,
    url,
    sha256: manifest.sha256,
  };
}
