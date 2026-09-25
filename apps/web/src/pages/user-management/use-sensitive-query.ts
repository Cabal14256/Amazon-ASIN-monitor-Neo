import { useQuery, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/http';
import { useManagement } from './context';
import { permissionDenied, visibleManagementData } from './management-data';

/** A denied read cannot expose a prior privileged snapshot on later failures. */
export function useSensitiveQuery<T>(
  queryKey: QueryKey,
  load: (signal: AbortSignal) => Promise<T>,
  enabled: boolean,
) {
  const { accessDenied, reportAccessDenied } = useManagement();
  const generation = useRef(0);
  const [denial, setDenial] = useState<{
    generation: number;
    error: ApiError;
  } | null>(null);
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: async ({ signal }) => {
      const startedGeneration = generation.current;
      try {
        return { value: await load(signal), generation: startedGeneration };
      } catch (error) {
        if (permissionDenied(error) && !signal.aborted) {
          const nextGeneration = ++generation.current;
          setDenial({ generation: nextGeneration, error });
          reportAccessDenied();
        }
        throw error;
      }
    },
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (
      denial &&
      query.isSuccess &&
      query.data?.generation === denial.generation
    ) {
      setDenial(null);
    }
  }, [denial, query.isSuccess, query.data]);
  return {
    query,
    data: visibleManagementData(
      query.data,
      denial?.generation ?? null,
      query.isError || accessDenied,
    ),
    error: denial?.error ?? query.error,
  };
}
