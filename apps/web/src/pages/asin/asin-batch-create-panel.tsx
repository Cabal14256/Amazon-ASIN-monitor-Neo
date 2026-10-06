import type { BatchCreateAsinsData } from '@asin-monitor/contracts';
import { useEffect, useRef, useState } from 'react';
import { createAccess } from '../../auth/access';
import { useAuth } from '../../auth/context';
import { ApiError, type HttpClient } from '../../lib/http';
import type { AsinBatchCreateInput } from '../../services/asin-batch-create';
import {
  catalogAccessDenied,
  catalogActionSourceCurrent,
  catalogWriteError,
  catalogWriteOutcomeUncertain,
} from '../catalog/catalog-data';
import type { CatalogSafetyGate } from '../catalog/catalog-safety-gate';
import type { CatalogAction, CatalogConfig } from '../catalog/catalog-types';
import { AsinBatchCreateForm } from './asin-batch-create-form';

export type BatchCreateAction = Extract<
  CatalogAction,
  { type: 'batch-create-asins' }
>;

/** The existing catalog coordinator owns the lock, persisted claim and rereads. */
export function AsinBatchCreatePanel({
  action,
  config,
  http,
  close,
  completed,
  denied,
  uncertain,
  writingChange,
  runExclusive,
  beginWrite,
  releaseWrite,
}: {
  action: BatchCreateAction;
  config: Extract<CatalogConfig, { id: 'asin' }>;
  http: Pick<HttpClient, 'request'>;
  close: () => void;
  completed: (
    result: BatchCreateAsinsData,
    action: BatchCreateAction,
    claim: CatalogSafetyGate,
  ) => Promise<void>;
  denied: () => void;
  uncertain: (
    action: BatchCreateAction,
    claim: CatalogSafetyGate,
  ) => Promise<void>;
  writingChange: (writing: boolean) => void;
  runExclusive: (work: () => Promise<void>) => Promise<void>;
  beginWrite: (action: CatalogAction) => CatalogSafetyGate;
  releaseWrite: (claim: CatalogSafetyGate) => void;
}) {
  const { identity, runtime } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  const original = useRef(identity.getSnapshot());
  const revision = useRef(runtime.session.revision);
  const current = () => {
    const latest = identity.getSnapshot();
    return (
      mounted.current &&
      runtime.session.revision === revision.current &&
      original.current.status === 'authenticated' &&
      latest.status === 'authenticated' &&
      latest.identity.user.id === original.current.identity.user.id &&
      latest.identity.sessionId === original.current.identity.sessionId &&
      createAccess(latest.identity).canWriteASIN
    );
  };
  const guard = () => {
    if (!current()) throw new ApiError('CANCELLED', '身份、权限或页面已变化');
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);

  async function submit(input: AsinBatchCreateInput) {
    if (busy.current || !config.writes?.batchCreateAsins) return;
    busy.current = true;
    setPending(true);
    setError(null);
    writingChange(true);
    const controller = new AbortController();
    request.current = controller;
    let claim: CatalogSafetyGate | null = null;
    let attempted = false;
    try {
      await runExclusive(async () => {
        guard();
        const source = await config.detail(
          http,
          action.group.id,
          controller.signal,
        );
        guard();
        if (!catalogActionSourceCurrent(action, source))
          throw new ApiError('HTTP', '记录已变化', 409);
        claim = beginWrite(action);
        attempted = true;
        const result = await config.writes!.batchCreateAsins!(
          http,
          input,
          controller.signal,
        );
        guard();
        await completed(result, action, claim);
      });
    } catch (cause) {
      // A late old-owner reply cannot change current-owner UI, caches or guard.
      // Its original persisted claim remains available for explicit recovery.
      if (current()) {
        if (catalogAccessDenied(cause)) {
          if (claim) releaseWrite(claim);
          denied();
        } else if (
          attempted &&
          claim &&
          catalogWriteOutcomeUncertain(cause, 'asin')
        )
          await uncertain(action, claim);
        else {
          if (claim) releaseWrite(claim);
          setError(catalogWriteError(cause));
        }
      }
    } finally {
      if (request.current === controller) request.current = null;
      busy.current = false;
      if (mounted.current) setPending(false);
      writingChange(false);
    }
  }

  return (
    <AsinBatchCreateForm
      group={action.group}
      pending={pending}
      error={error}
      submit={submit}
      close={close}
    />
  );
}
