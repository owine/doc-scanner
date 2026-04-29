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

  async uploadFile(name: string, bytes: Uint8Array, mimeType: string): Promise<UploadResult> {
    const rootMaybe = await this.sdk.getMyFilesRootFolder();
    const root = unwrapNode(rootMaybe);

    const uploader = await this.sdk.getFileUploader(root.uid, name, {
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

    return { nodeUid, driveUrl };
  }
}
