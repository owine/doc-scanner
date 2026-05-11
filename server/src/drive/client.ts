import {
  ProtonDriveClient,
  NullFeatureFlagProvider,
  type ProtonDriveTelemetry,
  type Logger,
  type MaybeNode,
  type NodeEntity,
  type DegradedNode,
} from '@protontech/drive-sdk';
import type { DB } from '../db.js';
import type { ProtonAuth, ProtonSession } from '../auth/srp.js';
import type { DecryptedUserKey } from '../auth/keys.js';
import { DriveAccount } from './account.js';
import { DriveHttpClient } from './http-client.js';
import { DriveSrpModule } from './srp-module.js';
import { EntitiesCache } from './entities-cache.js';
import { CryptoCache } from './crypto-cache.js';
import { EventIdStore } from './event-id-store.js';
import { getOpenPGPModule } from './crypto-module.js';
import { FolderCache } from './folder-cache.js';

export interface DriveClientConfig {
  db: DB;
  /** AES-256 key (base64) for the entities cache encryption envelope. */
  encryptionKey: string;
  /** Proton appversion string (e.g. "external-drive-docscanner@0.1.0"). */
  appVersion: string;
  /** Drive API base URL. Defaults to production. */
  baseUrl?: string;
  user: DecryptedUserKey;
  session: ProtonSession;
  protonAuth: ProtonAuth;
  onSessionRefreshed?: (session: ProtonSession) => void;
}

export interface ListRootChild {
  uid: string;
  name: string;
  type: string;
}

export interface ListRootResult {
  root: { uid: string; name: string };
  children: ListRootChild[];
}

export interface UploadResult {
  nodeUid: string;
  driveUrl: string;
  /** The actual filename used after collision-suffix retries, e.g. "Receipt (2)". */
  finalName: string;
}

export interface UploadOptions {
  /** Drive folder uid to upload into. Defaults to MyFilesRootFolder for back-compat. */
  parentFolderUid?: string;
}

/**
 * Thrown when 4 consecutive name collisions (base + 3 suffix attempts) all fail.
 * Routes should map this to HTTP 409 + a structured error so the PWA can prompt
 * the user to edit the filename and retry.
 */
export class UploadCollisionExhausted extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) (this as unknown as { cause: unknown }).cause = options.cause;
  }
}

// Heuristic for "is this error a name collision?". The Proton SDK's exact
// shape for collision errors is unverified (planned: empirical test in
// slice 2's manual smoke via the existing /api/drive/test-upload endpoint).
// Until verified, we treat any error message that mentions "exists",
// "conflict", "duplicate", or HTTP 409/422 as a collision. A non-collision
// error (e.g. network / auth) propagates immediately on the first attempt.
export function isCollisionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('exists') || msg.includes('conflict') || msg.includes('duplicate')
    || msg.includes('409') || msg.includes('422');
}

/**
 * Generic collision-retry runner — exported for testability without going
 * through the full DriveClient constructor (which requires real PGP keys).
 *
 * Calls `attempt(candidate)` for each of `[base, "base (2)", "base (3)",
 * "base (4)"]`. Returns the first successful result alongside the
 * `finalName` actually used. Throws `UploadCollisionExhausted` if all four
 * candidates collide; non-collision errors propagate immediately.
 */
export async function uploadWithCollisionRetry<T>(
  baseName: string,
  attempt: (candidate: string) => Promise<T>,
): Promise<{ result: T; finalName: string }> {
  const candidates = [baseName, `${baseName} (2)`, `${baseName} (3)`, `${baseName} (4)`];
  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      const result = await attempt(candidate);
      return { result, finalName: candidate };
    } catch (err) {
      if (!isCollisionError(err)) throw err;
      lastErr = err;
    }
  }
  throw new UploadCollisionExhausted(
    `name "${baseName}" collided after ${candidates.length} attempts`,
    { cause: lastErr },
  );
}

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const NULL_TELEMETRY: ProtonDriveTelemetry = {
  getLogger: () => NOOP_LOGGER,
  recordMetric: () => {},
};

/**
 * Unwrap a `MaybeNode` (`Result<NodeEntity, DegradedNode>`) into a plain
 * NodeEntity, throwing on the degraded branch. Phase 2 has no UI to
 * surface partial decryption, so a thrown error is the cleanest signal.
 */
function unwrapNode(maybe: MaybeNode): NodeEntity {
  if (maybe.ok) return maybe.value;
  const degraded = maybe.error as DegradedNode;
  throw new Error(
    `Drive node degraded (uid=${(degraded as { uid?: string }).uid ?? 'unknown'}): cannot decrypt`,
  );
}

/**
 * Facade over the Proton Drive SDK. Wires together all six adapters
 * (account, http, srp, entities cache, crypto cache, event-id store) plus
 * the OpenPGP crypto module, and exposes the narrow Phase 2 surface:
 *
 *   - listRoot()              — list children of "My files" root
 *   - uploadFile(name, bytes) — upload a single Uint8Array as a new file
 *
 * Construction is cheap; the adapters do the heavy lifting lazily.
 */
export class DriveClient {
  private readonly sdk: ProtonDriveClient;

  constructor(cfg: DriveClientConfig) {
    const httpClient = new DriveHttpClient({
      baseUrl: cfg.baseUrl ?? 'https://drive-api.proton.me',
      appVersion: cfg.appVersion,
      uid: cfg.session.uid,
      accessToken: cfg.session.accessToken,
    });

    this.sdk = new ProtonDriveClient({
      httpClient,
      entitiesCache: new EntitiesCache(cfg.db, cfg.encryptionKey),
      cryptoCache: new CryptoCache(),
      account: new DriveAccount(cfg.user),
      openPGPCryptoModule: getOpenPGPModule(),
      srpModule: new DriveSrpModule(),
      featureFlagProvider: new NullFeatureFlagProvider(),
      latestEventIdProvider: new EventIdStore(cfg.db),
      telemetry: NULL_TELEMETRY,
    });
  }

  /**
   * Construct a per-session folder-tree cache. The cache holds a reference
   * to this client's SDK and walks `iterateFolderChildren` recursively when
   * `refresh()` is called. Per-session lifetime keeps account boundaries.
   */
  createFolderCache(): FolderCache {
    return new FolderCache(this.sdk);
  }

  async listRoot(): Promise<ListRootResult> {
    const rootMaybe = await this.sdk.getMyFilesRootFolder();
    const root = unwrapNode(rootMaybe);

    const children: ListRootChild[] = [];
    for await (const childMaybe of this.sdk.iterateFolderChildren(root.uid)) {
      if (!childMaybe.ok) {
        // Skip degraded children rather than failing the whole listing.
        continue;
      }
      children.push({
        uid: childMaybe.value.uid,
        name: childMaybe.value.name,
        type: String(childMaybe.value.type),
      });
    }

    return {
      root: { uid: root.uid, name: root.name },
      children,
    };
  }

  /**
   * Upload `bytes` as a new file in Drive.
   *
   * `opts.parentFolderUid` selects the destination folder; omit for the
   * MyFilesRootFolder (back-compat for the Phase 2 test endpoint).
   *
   * On a name collision, retries with `name (2)`, `name (3)`, `name (4)`
   * before throwing `UploadCollisionExhausted`. The returned `finalName`
   * reflects whichever name actually succeeded — the route surfaces it so
   * the PWA can persist what Drive actually has.
   *
   * Non-collision errors (network, auth, quota) propagate immediately.
   */
  async uploadFile(
    name: string,
    bytes: Uint8Array,
    mimeType: string,
    opts: UploadOptions = {},
  ): Promise<UploadResult> {
    const parentUid = opts.parentFolderUid
      ?? unwrapNode(await this.sdk.getMyFilesRootFolder()).uid;

    const { result } = await uploadWithCollisionRetry(name, (candidate) =>
      this.uploadOnce(parentUid, candidate, bytes, mimeType),
    );
    return result;
  }

  private async uploadOnce(
    parentUid: string,
    name: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<UploadResult> {
    const uploader = await this.sdk.getFileUploader(parentUid, name, {
      mediaType: mimeType,
      expectedSize: bytes.byteLength,
      modificationTime: new Date(),
    });

    // Wrap the flat byte buffer as a single-chunk ReadableStream. The SDK
    // streams blocks, but a one-shot enqueue is well-defined and the
    // smallest possible adapter for callers that already have the bytes
    // resident in memory.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    const controller = await uploader.uploadFromStream(stream, []);
    const { nodeUid } = await controller.completion();

    let driveUrl: string;
    try {
      driveUrl = await this.sdk.experimental.getNodeUrl(nodeUid);
    } catch {
      driveUrl = `https://drive.proton.me/${nodeUid}`;
    }

    return { nodeUid, driveUrl, finalName: name };
  }
}
