import * as Sentry from '@sentry/hono/node';
import { redactExact } from './scrub.js';

/**
 * Drive operations we report on. A failure in any of these can mean a scan
 * never reaches Proton Drive, which is the one failure that must be heard.
 */
export type DriveOperation = 'folder-lookup' | 'folder-create' | 'folder-walk' | 'upload' | 'download' | 'session-refresh';

/**
 * Reports a Drive failure tagged with its operation. `sensitive` lists values
 * the caller knows are private (the document name) so they are removed
 * verbatim, wherever the SDK echoed them. No-op when Sentry is not initialized.
 */
export function captureDriveFailure(error: unknown, operation: DriveOperation, sensitive: readonly string[] = []): void {
  Sentry.withScope((scope) => {
    scope.setTag('drive.operation', operation);
    if (sensitive.length > 0) scope.addEventProcessor((event) => redactExact(event, sensitive));
    Sentry.captureException(error);
  });
}

/**
 * Reports an auth failure the user cannot fix by retyping (the caller filters
 * out wrong passwords and TOTP typos). Tagged with the step that broke.
 */
export function captureAuthFailure(error: unknown, operation: 'login', stage: string): void {
  Sentry.withScope((scope) => {
    scope.setTag('auth.operation', operation);
    scope.setTag('auth.stage', stage);
    Sentry.captureException(error);
  });
}

/** Runs `fn`, reporting and rethrowing any failure as `operation`. */
export async function reportingDriveFailure<T>(
  operation: DriveOperation,
  fn: () => Promise<T>,
  sensitive: readonly string[] = [],
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    captureDriveFailure(error, operation, sensitive);
    throw error;
  }
}

export type DocumentStage = 'analyze' | 'prepare' | 'file';

/**
 * Reports a document that reached `failed`, tagged with the stage that
 * broke. Names passed in `sensitive` (and their extension-less stems) are
 * redacted wherever they appear in the event's free text. Callers must not
 * throw errors that embed document content.
 */
export function captureDocumentFailure(error: unknown, stage: DocumentStage, sensitive: readonly string[] = []): void {
  Sentry.withScope((scope) => {
    scope.setTag('document.stage', stage);
    const values = sensitive.filter((v) => v.length > 0);
    if (values.length > 0) scope.addEventProcessor((event) => redactExact(event, values));
    Sentry.captureException(error);
  });
}
