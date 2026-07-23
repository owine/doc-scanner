import { createHash } from 'node:crypto';
import {
  ProtonDriveClient,
  NullFeatureFlagProvider,
  type ProtonDriveTelemetry,
  type Logger,
  type NodeEntity,
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
import { getOrCreateClientUid } from './client-uid.js';
import { getOpenPGPModule } from './crypto-module.js';

/** Proton's production Drive API host. The SDK config wants a host, not a URL. */
const DEFAULT_DRIVE_HOST = 'drive-api.proton.me';

export interface DriveClientConfig {
  db: DB;
  /** AES-256 key (base64) for the entities cache encryption envelope. */
  encryptionKey: string;
  /** Proton appversion string (e.g. "external-drive-docscanner@0.1.0"). */
  appVersion: string;
  /**
   * Drive API host, with or without scheme. Defaults to production.
   * The SDK builds its own URLs from this, so it must reach the SDK config —
   * setting it only on our HTTP adapter would do nothing.
   */
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
  /** Children that could not be decrypted and were omitted from `children`. */
  degradedCount: number;
}

export interface UploadResult {
  nodeUid: string;
  driveUrl: string;
  /** The name actually used, which may be de-duplicated by the SDK. */
  name: string;
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
 * `NodeEntity.name` is a `Result`: the SDK can decrypt the node while failing
 * to decrypt its name (e.g. a name signed with an unavailable key). Returns
 * the name, or null when it could not be decrypted. This is the field-level
 * successor to the pre-0.17 node-level `DegradedNode`.
 */
export function nodeName(node: NodeEntity): string | null {
  return node.name.ok ? node.name.value : null;
}

/** The SDK's config takes a bare host; strip any scheme and trailing slash. */
function toHost(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * Facade over the Proton Drive SDK. Wires together all six adapters
 * (account, http, srp, entities cache, crypto cache, event-id store) plus
 * the OpenPGP crypto module, and exposes the narrow Phase 2 surface:
 *
 *   - listRoot()              — list children of "My files" root
 *   - uploadFile(name, bytes) — upload a single Uint8Array as a new file
 *   - clearCaches()           — drop persisted state on logout
 *
 * Construction is cheap; the adapters do the heavy lifting lazily.
 */
export class DriveClient {
  private readonly sdk: ProtonDriveClient;
  private readonly entitiesCache: EntitiesCache;
  private readonly eventIdStore: EventIdStore;
  /** Mutable: replaced in place when the access token is refreshed. */
  private session: ProtonSession;

  constructor(cfg: DriveClientConfig) {
    this.session = cfg.session;
    this.entitiesCache = new EntitiesCache(cfg.db, cfg.encryptionKey);
    this.eventIdStore = new EventIdStore(cfg.db);

    const httpClient = new DriveHttpClient({
      appVersion: cfg.appVersion,
      getSession: () => this.session,
      refreshSession: async () => {
        this.session = await cfg.protonAuth.refresh(this.session);
        cfg.onSessionRefreshed?.(this.session);
        return this.session;
      },
    });

    this.sdk = new ProtonDriveClient({
      httpClient,
      entitiesCache: this.entitiesCache,
      cryptoCache: new CryptoCache(),
      account: new DriveAccount(cfg.user),
      openPGPCryptoModule: getOpenPGPModule(),
      srpModule: new DriveSrpModule(),
      featureFlagProvider: new NullFeatureFlagProvider(),
      latestEventIdProvider: this.eventIdStore,
      telemetry: NULL_TELEMETRY,
      config: {
        baseUrl: toHost(cfg.baseUrl ?? DEFAULT_DRIVE_HOST),
        clientUid: getOrCreateClientUid(cfg.db),
      },
    });
  }

  async listRoot(): Promise<ListRootResult> {
    const root = await this.sdk.getMyFilesRootFolder();

    const children: ListRootChild[] = [];
    let degradedCount = 0;
    for await (const child of this.sdk.iterateFolderChildren(root.uid)) {
      const name = nodeName(child);
      if (name === null) {
        // Name could not be decrypted; skip it but keep the count visible.
        degradedCount += 1;
        continue;
      }
      children.push({ uid: child.uid, name, type: String(child.type) });
    }

    return {
      root: { uid: root.uid, name: nodeName(root) ?? '(unknown)' },
      children,
      degradedCount,
    };
  }

  async uploadFile(name: string, bytes: Uint8Array, mimeType: string): Promise<UploadResult> {
    const root = await this.sdk.getMyFilesRootFolder();

    // `getFileUploader` rejects outright when the name is taken, so resolve a
    // free name first ("scan.pdf" -> "scan (1).pdf") instead of surfacing a
    // collision as an upload failure.
    const availableName = await this.sdk.getAvailableName(root.uid, name);

    const uploader = await this.sdk.getFileUploader(root.uid, availableName, {
      mediaType: mimeType,
      expectedSize: bytes.byteLength,
      // We hold the whole buffer, so let the SDK verify what it uploaded
      // against a hash we computed independently.
      expectedSha1: createHash('sha1').update(bytes).digest('hex'),
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

    return { nodeUid, driveUrl, name: availableName };
  }

  /**
   * Drops all persisted SDK state. Must be called on logout: the caches are
   * keyed by SDK-internal IDs with no account scoping, so entities left behind
   * by one account would be served to the next one and fail to decrypt.
   */
  async clearCaches(): Promise<void> {
    await this.entitiesCache.clear();
    await this.eventIdStore.clear();
  }
}
