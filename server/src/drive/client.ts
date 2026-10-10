import { createHash } from 'node:crypto';
import {
  ProtonDriveClient,
  NullFeatureFlagProvider,
  NodeType,
  NodeWithSameNameExistsValidationError,
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
import { reportingDriveFailure } from '../observability/report.js';
import { logger } from '../logger.js';
import { walkFolderTree, isNode, type TreeFolder, type WalkOptions } from './folder-tree.js';
import { rethrowUnlessBrokenNodes } from './broken-nodes.js';

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

export interface UploadOptions {
  /** Folder to upload into; defaults to the root of My files. */
  parentFolderUid?: string;
}

/** createFolder found the name already taken (by a folder, file or undecryptable node). */
export class FolderNameTakenError extends Error {
  constructor(readonly existingNodeUid?: string) {
    super('a node with this name already exists in the folder');
    this.name = 'FolderNameTakenError';
  }
}

/** A node whose name decrypted. */
type NamedNode = NodeEntity & { name: { ok: true; value: string } };

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
 *   - uploadFile(name, bytes) — upload a single Uint8Array as a new file,
 *                               into the root or a given folder
 *   - findChildFolder / createFolder — resolve or create a folder by name
 *   - findFileBySha1()        — find an already-uploaded file in a folder
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
      // The HTTP adapter swallows a failed refresh and hands the SDK the
      // original 401, so this is the only place that failure is visible.
      refreshSession: () => reportingDriveFailure('session-refresh', async () => {
        this.session = await cfg.protonAuth.refresh(this.session);
        cfg.onSessionRefreshed?.(this.session);
        return this.session;
      }),
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

  async uploadFile(
    name: string,
    bytes: Uint8Array,
    mimeType: string,
    opts: UploadOptions = {},
  ): Promise<UploadResult> {
    // Failures are reported by stage (a failed upload is a lost document).
    // The name is passed as sensitive so it is redacted wherever the SDK
    // echoes it; the bytes are never handed to the reporter at all.
    const { parentUid, availableName } = await reportingDriveFailure('folder-lookup', async () => {
      const parentUid = opts.parentFolderUid ?? (await this.sdk.getMyFilesRootFolder()).uid;
      // `getFileUploader` rejects outright when the name is taken, so resolve
      // a free name first ("scan.pdf" -> "scan (1).pdf") instead of surfacing
      // a collision as an upload failure.
      const availableName = await this.sdk.getAvailableName(parentUid, name);
      return { parentUid, availableName };
    }, [name]);

    const { nodeUid } = await reportingDriveFailure('upload', async () => {
      const uploader = await this.sdk.getFileUploader(parentUid, availableName, {
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
      return controller.completion();
    }, [name, availableName]);

    let driveUrl: string;
    try {
      driveUrl = await this.sdk.experimental.getNodeUrl(nodeUid);
    } catch {
      driveUrl = `https://drive.proton.me/${nodeUid}`;
    }

    return { nodeUid, driveUrl, name: availableName };
  }

  /**
   * A folder's live children whose names decrypt (trashed, missing and
   * undecryptable ones are skipped). The SDK yields every loadable node, then
   * throws a base ProtonDriveError wrapping whatever failed. With
   * `tolerateBrokenSiblings` that is swallowed when every cause is a
   * per-node problem; a transport failure always propagates (see
   * rethrowUnlessBrokenNodes).
   */
  private async *children(
    parentUid: string,
    opts: { filter?: { type: NodeType }; tolerateBrokenSiblings?: boolean } = {},
  ): AsyncGenerator<NamedNode> {
    const uids: string[] = [];
    for await (const uid of this.sdk.iterateFolderChildrenNodeUids(parentUid, opts.filter)) uids.push(uid);
    if (uids.length === 0) return;
    try {
      for await (const n of this.sdk.iterateNodes(uids)) {
        if (isNode(n) && !n.trashTime && n.name.ok) yield n as NamedNode;
      }
    } catch (error) {
      if (!opts.tolerateBrokenSiblings) throw error;
      rethrowUnlessBrokenNodes(error);
      logger.warn({ parentUid }, 'some folder children could not be loaded');
    }
  }

  /** The uid of `parentUid`'s child folder called `name`, if there is one. */
  async findChildFolder(parentUid: string, name: string): Promise<string | null> {
    return reportingDriveFailure('folder-lookup', async () => {
      const wanted = name.normalize('NFC');
      for await (const n of this.children(parentUid, { filter: { type: NodeType.Folder }, tolerateBrokenSiblings: true })) {
        if (n.type === NodeType.Folder && n.name.value.normalize('NFC') === wanted) return n.uid;
      }
      return null;
    }, [name]);
  }

  /**
   * Creates a folder. Throws FolderNameTakenError when the name is taken (the
   * SDK refuses), which is expected and so not reported as a Drive failure.
   */
  async createFolder(parentUid: string, name: string): Promise<string> {
    const result = await reportingDriveFailure('folder-create', async () => {
      try {
        return { uid: (await this.sdk.createFolder(parentUid, name)).uid };
      } catch (error) {
        if (error instanceof NodeWithSameNameExistsValidationError) {
          return { taken: error.existingNodeUid };
        }
        throw error;
      }
    }, [name]);
    if ('taken' in result) throw new FolderNameTakenError(result.taken);
    return result.uid;
  }

  /**
   * A file in `parentUid` whose claimed SHA-1 matches: how filing tells,
   * after a crash, whether its upload already happened. Does not tolerate
   * broken siblings: a wrong null here means a duplicate upload, a retry is free.
   */
  async findFileBySha1(parentUid: string, sha1: string): Promise<{ uid: string; name: string } | null> {
    return reportingDriveFailure('folder-lookup', async () => {
      for await (const n of this.children(parentUid)) {
        if (n.type === NodeType.File && n.activeRevision?.claimedDigests?.sha1 === sha1) {
          return { uid: n.uid, name: n.name.value };
        }
      }
      return null;
    });
  }

  /** Every folder in My files with its files; see folder-tree.ts. */
  async walkFolderTree(opts?: WalkOptions): Promise<TreeFolder[]> {
    return reportingDriveFailure('folder-walk', () => walkFolderTree(this.sdk, opts));
  }

  /** Downloads, decrypts and verifies a file's active revision into memory. */
  async downloadFile(nodeUid: string, signal?: AbortSignal): Promise<Uint8Array> {
    return reportingDriveFailure('download', async () => {
      const downloader = await this.sdk.getFileDownloader(nodeUid, signal);
      const chunks: Uint8Array[] = [];
      const sink = new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
        },
      });
      await downloader.downloadToStream(sink).completion();
      return Buffer.concat(chunks);
    });
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
